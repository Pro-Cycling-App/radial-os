import { describe, expect, it } from "vitest";
import {
  CustomSessionImpl,
  describeRadialAccount,
  describeRadialVendor,
  type RadialReader,
} from "../src/custom.js";
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
    const session = new CustomSessionImpl(queue, reader, { name: "Radial", message: "" });

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
    const session = new CustomSessionImpl(queue, reader, { name: "Radial", message: "" });

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
    const session = new CustomSessionImpl(queue, reader, { name: "Radial", message: "Pro cycling." });
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
