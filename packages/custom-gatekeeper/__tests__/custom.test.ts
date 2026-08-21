import { describe, expect, it } from "vitest";
import {
  BranchReaders,
  CustomSessionImpl,
  ProductionOnly,
  describeRadialAccount,
  describeRadialVendor,
  type RadialReader,
} from "../src/custom.js";
import { BRANCH_CACHE_MS, NeonBranches } from "../src/neon-branches.js";
import { assertReadOnlySafe } from "../src/radial-db.js";
import TYPES_CODE from "../src/types-code.js";

function observing() {
  const observations: unknown[] = [];
  let disposed = false;
  const queue = {
    authorizeObservation(value: unknown) {
      observations.push(value);
      return Promise.resolve();
    },
    [Symbol.dispose]() {
      disposed = true;
    },
  };
  return { queue, observations, isDisposed: () => disposed };
}

const reader: RadialReader = {
  async query(sql, params) {
    return {
      rows: [{ sql, params: params ?? null }],
      columns: [{ name: "sql", type: "text" }, { name: "params", type: "jsonb" }],
      rowCount: 1,
    };
  },
  async listTables() {
    return [{ name: "riders", kind: "table" }, { name: "race_edition_base", kind: "view" }];
  },
  async describeTable(name) {
    if (name !== "riders") throw new Error(`No table or view named "${name}" in the public schema.`);
    return [{ name: "id", type: "uuid", nullable: false, default: null }];
  },
};

describe("radial gatekeeper", () => {
  it("describes an auto-provisioned singleton named Radial", () => {
    expect(describeRadialVendor()).toMatchObject({
      displayName: "Radial",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    expect(describeRadialAccount()).toMatchObject({
      displayName: "Radial",
      singleton: { tsType: "RadialSession" },
    });
    expect(TYPES_CODE).toContain("export interface RadialSession");
  });

  it("records the SQL and parameters as an observation before returning rows", async () => {
    const { queue, observations } = observing();
    const session = new CustomSessionImpl(queue, new ProductionOnly(reader), { name: "Radial", message: "" });

    const result = await session.query("select count(*) from riders where id = $1", ["abc"]);
    expect(result.rowCount).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ title: "Run read-only SQL on the Radial database" });
    const description = (observations[0] as { description: string }).description;
    expect(description).toContain("select count(*) from riders where id = $1");
    expect(description).toContain('["abc"]');
    expect(description).toContain("1 row");
  });

  it("observes schema reads and surfaces a missing table as an error", async () => {
    const { queue, observations } = observing();
    const session = new CustomSessionImpl(queue, new ProductionOnly(reader), { name: "Radial", message: "" });

    await expect(session.listTables()).resolves.toHaveLength(2);
    await expect(session.describeTable("riders")).resolves.toEqual([
      { name: "id", type: "uuid", nullable: false, default: null },
    ]);
    await expect(session.describeTable("nope")).rejects.toThrow('No table or view named "nope"');
    // The failed describe recorded nothing: there was no data to observe.
    expect(observations.map(o => (o as { title: string }).title)).toEqual([
      "List Radial database tables",
      "Describe a Radial database table",
    ]);
  });

  it("returns deployment information and disposes the queue with the session", async () => {
    const { queue, isDisposed } = observing();
    const session = new CustomSessionImpl(queue, new ProductionOnly(reader), { name: "Radial", message: "Pro cycling." });
    await expect(session.getDeploymentInfo()).resolves.toEqual({ name: "Radial", message: "Pro cycling." });
    session[Symbol.dispose]();
    expect(isDisposed()).toBe(true);
  });

  it("rejects statements that reach outside the database", () => {
    expect(() => assertReadOnlySafe("select * from dblink('host=x', 'select 1') as t(a int)")).toThrow(/dblink/);
    expect(() => assertReadOnlySafe("select pg_read_file('/etc/passwd')")).toThrow(/pg_read_file/);
    expect(() => assertReadOnlySafe("copy riders to program 'cat'")).toThrow(/COPY/);
    expect(() => assertReadOnlySafe("select count(*) from riders where copy_of is null")).not.toThrow();
  });
});

const BRANCHES = {
  branches: [
    { id: "br-dev", name: "development", default: false, created_at: "2026-08-01T00:00:00Z" },
    { id: "br-prod", name: "production", default: true, created_at: "2026-01-01T00:00:00Z" },
  ],
};
const ENDPOINTS = {
  "br-dev": { endpoints: [{ host: "ep-dev.neon.tech", type: "read_write", current_state: "idle" }] },
  "br-prod": { endpoints: [
    { host: "ep-prod.neon.tech", type: "read_write", current_state: "active" },
    { host: "ep-prod-ro.neon.tech", type: "read_only", current_state: "active" },
  ] },
};

function fakeNeon() {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push(url);
    const headers = init.headers as Record<string, string>;
    if (headers.authorization !== "Bearer viewer-key") return new Response("", { status: 401 });
    if (url.endsWith("/branches")) return Response.json(BRANCHES);
    const m = /\/branches\/([^/]+)\/endpoints$/.exec(url);
    if (m) return Response.json(ENDPOINTS[m[1] as keyof typeof ENDPOINTS]);
    return new Response("", { status: 404 });
  };
  return { calls, fetchImpl };
}

describe("neon branches", () => {
  it("lists branches production-first, caches for a minute, and refreshes on demand", async () => {
    let now = 0;
    const { calls, fetchImpl } = fakeNeon();
    const branches = new NeonBranches("viewer-key", "proj", fetchImpl, () => now);
    const first = await branches.list();
    expect(first.map(b => b.name)).toEqual(["production", "development"]);
    expect(first[0]).toMatchObject({ id: "br-prod", isDefault: true });
    await branches.list();
    expect(calls).toHaveLength(1);
    now = BRANCH_CACHE_MS;
    await branches.list();
    expect(calls).toHaveLength(2);
    await branches.refresh();
    expect(calls).toHaveLength(3);
  });

  it("resolves a branch host, preferring a read-only endpoint, and names an unknown branch", async () => {
    const { fetchImpl } = fakeNeon();
    const branches = new NeonBranches("viewer-key", "proj", fetchImpl, () => 0);
    await expect(branches.host(await branches.byName("production"))).resolves.toBe("ep-prod-ro.neon.tech");
    await expect(branches.host(await branches.byName("development"))).resolves.toBe("ep-dev.neon.tech");
    await expect(branches.byName("nope")).rejects.toThrow('No Neon branch named "nope"');
  });

  it("calls fetch unbound, as the platform requires", async () => {
    // Workers' fetch throws "Illegal invocation" when called with a foreign `this`.
    const strict = async function (this: unknown, url: string, init: RequestInit) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return fakeNeon().fetchImpl(url, init);
    };
    const branches = new NeonBranches("viewer-key", "proj", strict, () => 0);
    await expect(branches.list()).resolves.toHaveLength(2);
  });

  it("surfaces a rejected key as an error rather than an empty list", async () => {
    const { fetchImpl } = fakeNeon();
    const branches = new NeonBranches("wrong-key", "proj", fetchImpl, () => 0);
    await expect(branches.list()).rejects.toThrow("Neon API /branches answered 401");
  });
});

describe("branch-aware session", () => {
  it("reads production by default, names the branch in the observation otherwise", async () => {
    const { queue, observations } = observing();
    const { fetchImpl } = fakeNeon();
    const readers = new BranchReaders(reader, new NeonBranches("viewer-key", "proj", fetchImpl, () => 0), "pw");
    const session = new CustomSessionImpl(queue, readers, { name: "Radial", message: "" });

    await session.query("select 1");
    await session.query("select 1", [], { branch: "production" });
    // Naming production explicitly reads the same replica, and the observation says it was named.
    expect(observations.map(o => (o as { title: string }).title)).toEqual([
      "Run read-only SQL on the Radial database",
      "Run read-only SQL on the Radial database (branch production)",
    ]);

    await expect(session.query("select 1", [], { branch: "nope" })).rejects.toThrow('No Neon branch named "nope"');
    await expect(session.listBranches()).resolves.toHaveLength(2);
    await expect(session.refreshBranches()).resolves.toHaveLength(2);
    expect(observations.at(-2)).toMatchObject({ title: "List Radial database branches" });
    expect(observations.at(-1)).toMatchObject({ title: "Refresh Radial database branches" });
  });

  it("has no branches and refuses a branch when Neon access is not configured", async () => {
    const { queue } = observing();
    const session = new CustomSessionImpl(queue, new ProductionOnly(reader), { name: "Radial", message: "" });
    await expect(session.listBranches()).resolves.toEqual([]);
    await expect(session.listTables({ branch: "development" })).rejects.toThrow("reads production only");
  });
});
