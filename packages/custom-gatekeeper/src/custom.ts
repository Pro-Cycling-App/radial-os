// The Radial gatekeeper: read-only access to the Radial production database for agents and
// gadgets, plus the operator's description of the deployment.
//
// The exported class names (`CustomGatekeeper`, `CustomAccount`, `CustomVerifier`,
// `CustomSessionImpl`) are the starter's and stay as they are: the Workshop stores stubs to the
// account and the singleton class irrevocably (`allow_irrevocable_stub_storage`), so a rename would
// orphan every user's existing connection. Everything a person or an agent sees says Radial.

import {
  DurableObject,
  RpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { NeonBranches, type RadialBranch } from "./neon-branches.js";
import { RadialDb } from "./radial-db.js";
import type {
  RadialDeploymentInfo,
  RadialQueryResult,
  RadialReadOptions,
  RadialSession,
  RadialSqlValue,
  RadialTable,
  RadialTableColumn,
} from "./types.js";
import TYPES_CODE from "./types-code.js";

const RADIAL_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' stroke-width='18'><circle cx='128' cy='128' r='96'/><circle cx='128' cy='128' r='14'/><path d='M128 32v82M128 142v82M32 128h82M142 128h82M60 60l58 58M138 138l58 58M196 60l-58 58M118 138l-58 58'/></svg>",
    ),
};

type ObservationQueue = Pick<ApprovalQueue, "authorizeObservation"> &
  Partial<{ [Symbol.dispose](): void }>;

/** The database reads a session needs; `RadialDb` in production, a stub in tests. */
export type RadialReader = Pick<RadialDb, "query" | "listTables" | "describeTable">;

/** Where a session's reads go: a reader per branch, and the branch list. */
export interface RadialReaders {
  /** The reader for a branch; `undefined` means production. Throws for an unknown branch. */
  forBranch(branch: string | undefined): Promise<RadialReader>;
  listBranches(): Promise<RadialBranch[]>;
  refreshBranches(): Promise<RadialBranch[]>;
}

/**
 * Production reads use the installed `DATABASE_URL` (the read-only replica). Any other branch is
 * looked up in Neon and connected as `radial_os` with the same password — Neon copies a role and
 * its password to every child branch, so every branch created since the role was made has it. A
 * branch older than the role refuses the password, which is reported as such.
 */
export class BranchReaders implements RadialReaders {
  readonly #production: RadialReader;
  readonly #branches: NeonBranches;
  readonly #password: string;
  readonly #byBranchId = new Map<string, RadialReader>();

  constructor(production: RadialReader, branches: NeonBranches, password: string) {
    this.#production = production;
    this.#branches = branches;
    this.#password = password;
  }

  async forBranch(name: string | undefined): Promise<RadialReader> {
    if (name === undefined) return this.#production;
    const branch = await this.#branches.byName(name);
    if (branch.isDefault) return this.#production;
    const cached = this.#byBranchId.get(branch.id);
    if (cached !== undefined) return cached;
    const host = await this.#branches.host(branch);
    const url = `postgresql://radial_os:${encodeURIComponent(this.#password)}@${host}/neondb?sslmode=require`;
    const reader = new RadialDb(url);
    this.#byBranchId.set(branch.id, reader);
    return reader;
  }

  listBranches(): Promise<RadialBranch[]> {
    return this.#branches.list();
  }

  async refreshBranches(): Promise<RadialBranch[]> {
    this.#byBranchId.clear();
    return this.#branches.refresh();
  }
}

/** A single production reader and no other branches — for tests and for a deploy without Neon access. */
export class ProductionOnly implements RadialReaders {
  readonly #production: RadialReader;
  constructor(production: RadialReader) {
    this.#production = production;
  }
  async forBranch(name: string | undefined): Promise<RadialReader> {
    if (name !== undefined) throw new Error("This deployment reads production only; no other branch is reachable.");
    return this.#production;
  }
  async listBranches(): Promise<RadialBranch[]> {
    return [];
  }
  async refreshBranches(): Promise<RadialBranch[]> {
    return [];
  }
}

/** "the Radial database" or "the Radial database (branch development)". */
function databaseName(branch: string | undefined): string {
  return branch === undefined ? "the Radial database" : `the Radial database (branch ${branch})`;
}

export function describeRadialVendor(): VendorDescription {
  return {
    displayName: "Radial",
    url: "https://radial.racing",
    logo: RADIAL_ICON,
    color: "#fff1e6",
    tagline: "Read-only access to the Radial database",
    description:
      "Query the Radial production database (races, riders, teams, results, images, provenance) " +
      "with read-only SQL. Every read is recorded; nothing can be written.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

export function describeRadialAccount(): AccountDescription {
  return {
    displayName: "Radial",
    avatar: RADIAL_ICON,
    singleton: { tsType: "RadialSession" },
  };
}

// An observation description shows the approver what was read. For SQL that is the statement
// itself; parameters are included so a parameterized query is as reviewable as an inlined one.
function describeQuery(
  sql: string, params: RadialSqlValue[] | undefined, rowCount: number, branch: string | undefined,
): string {
  const paramsLine = params && params.length > 0
    ? `\n\nParameters: \`${JSON.stringify(params)}\``
    : "";
  return `Ran a read-only query against ${databaseName(branch)} (${rowCount} row${rowCount === 1 ? "" : "s"}).` +
    "\n\n```sql\n" + sql + "\n```" + paramsLine;
}

@validateRpc()
export class CustomSessionImpl extends RpcTarget implements RadialSession {
  readonly #approvalQueue: ObservationQueue;
  readonly #readers: RadialReaders;
  readonly #info: RadialDeploymentInfo;

  constructor(approvalQueue: ObservationQueue, readers: RadialReaders, info: RadialDeploymentInfo) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#readers = readers;
    this.#info = info;
  }

  async query(sql: string, params?: RadialSqlValue[], options?: RadialReadOptions): Promise<RadialQueryResult> {
    // Fetch first, then authorize: the observation can then say how much was read, and nothing is
    // returned to the caller until the queue has allowed it.
    const branch = options?.branch;
    const db = await this.#readers.forBranch(branch);
    const result = await db.query(sql, params);
    await this.#approvalQueue.authorizeObservation({
      title: branch === undefined
        ? "Run read-only SQL on the Radial database"
        : `Run read-only SQL on the Radial database (branch ${branch})`,
      description: describeQuery(sql, params, result.rowCount, branch),
    });
    return result;
  }

  async listTables(options?: RadialReadOptions): Promise<RadialTable[]> {
    const branch = options?.branch;
    const db = await this.#readers.forBranch(branch);
    const tables = await db.listTables();
    await this.#approvalQueue.authorizeObservation({
      title: "List Radial database tables",
      description: `Listed the ${tables.length} tables and views in ${databaseName(branch)}.`,
    });
    return tables;
  }

  async describeTable(name: string, options?: RadialReadOptions): Promise<RadialTableColumn[]> {
    const branch = options?.branch;
    const db = await this.#readers.forBranch(branch);
    const columns = await db.describeTable(name);
    await this.#approvalQueue.authorizeObservation({
      title: "Describe a Radial database table",
      description: `Read the ${columns.length} columns of \`public.${name}\` in ${databaseName(branch)}.`,
    });
    return columns;
  }

  async listBranches(): Promise<RadialBranch[]> {
    const branches = await this.#readers.listBranches();
    await this.#approvalQueue.authorizeObservation({
      title: "List Radial database branches",
      description: `Listed the ${branches.length} Neon branches of the Radial database.`,
    });
    return branches;
  }

  async refreshBranches(): Promise<RadialBranch[]> {
    const branches = await this.#readers.refreshBranches();
    await this.#approvalQueue.authorizeObservation({
      title: "Refresh Radial database branches",
      description: `Re-read the branch list from Neon: ${branches.length} branches.`,
    });
    return branches;
  }

  async getDeploymentInfo(): Promise<RadialDeploymentInfo> {
    await this.#approvalQueue.authorizeObservation({
      title: "Read deployment information",
      description: "Read the description of this Radial OS deployment.",
    });
    return this.#info;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

@validateRpc()
export class CustomGatekeeper extends DurableObject<Cloudflare.Env> implements Gatekeeper<RadialSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "radial://database",
      title: "Radial database (read-only)",
      snippet: "Read-only SQL over the Radial production database: races, riders, teams, results, images, provenance.",
      suggestedBindingName: "RADIAL",
      tsType: "RadialSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<RadialSession> {
    const production = new RadialDb(this.env.DATABASE_URL);
    // Branch switching needs the Neon Viewer key and the role password; without both, production only.
    const readers = this.env.NEON_API_KEY && this.env.RADIAL_OS_DATABASE_PASSWORD
      ? new BranchReaders(
          production,
          new NeonBranches(this.env.NEON_API_KEY, this.env.NEON_PROJECT_ID),
          this.env.RADIAL_OS_DATABASE_PASSWORD)
      : new ProductionOnly(production);
    return new CustomSessionImpl(approvalQueue.dup(), readers, {
      name: this.env.CUSTOM_NAME,
      message: this.env.CUSTOM_MESSAGE,
    });
  }

  // Every signed-in user of this deployment may read the same data (the role is SELECT-only and
  // Access admits only the team), so every observer is admitted. See README.md#observer-policy.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    throw new Error(`The Radial gatekeeper has no actions (${action}).`);
  }

  async rejectAction(_action: number): Promise<void> {}

  async revertAction(_action: number): Promise<void> {
    throw new Error("The Radial gatekeeper has no actions to revert.");
  }
}

@validateRpc()
export class CustomAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return describeRadialAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<RadialSession>>> {
    return this.ctx.exports.CustomGatekeeper({});
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("The Radial gatekeeper has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("The Radial gatekeeper has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("The Radial gatekeeper has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CustomVerifier({});
  }
}

@validateRpc()
export class CustomVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return describeRadialVendor();
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.CustomAccount({});
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("The Radial gatekeeper is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
