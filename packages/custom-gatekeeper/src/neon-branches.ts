// The Neon half of branch switching: which branches the project has, and the host each one's
// compute answers on. Read with a Viewer-role API key, which can list metadata and nothing else
// (Neon answers every mutating verb with 404 "project not found" for it); the Worker never holds
// a connection string from Neon — it composes one from a host here and the `radial_os` password.

/** One branch of the Neon project. */
export interface RadialBranch {
  /** Neon branch name — what `query({ branch })` takes. */
  name: string;
  id: string;
  /** The project's default branch: production. Reads go to its read-only replica. */
  isDefault: boolean;
  createdAt: string;
}

interface NeonBranchJson { id: string; name: string; default: boolean; created_at: string }
interface NeonEndpointJson { host: string; type: "read_write" | "read_only"; current_state: string }

export const BRANCH_CACHE_MS = 60_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class NeonBranches {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #branches: RadialBranch[] | undefined;
  #listedAt = 0;
  readonly #hosts = new Map<string, string>();

  constructor(apiKey: string, projectId: string, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
    this.#apiKey = apiKey;
    this.#base = `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`;
    this.#fetch = fetchImpl;
    this.#now = now;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await this.#fetch(this.#base + path, {
      headers: { authorization: `Bearer ${this.#apiKey}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Neon API ${path} answered ${response.status}.`);
    }
    return response.json() as Promise<T>;
  }

  /** The project's branches, cached for a minute. */
  async list(): Promise<RadialBranch[]> {
    if (this.#branches !== undefined && this.#now() - this.#listedAt < BRANCH_CACHE_MS) {
      return this.#branches;
    }
    return this.refresh();
  }

  /** Re-read the branch list from Neon now, and forget cached hosts. */
  async refresh(): Promise<RadialBranch[]> {
    const { branches } = await this.#get<{ branches: NeonBranchJson[] }>("/branches");
    this.#branches = branches
      .map(b => ({ name: b.name, id: b.id, isDefault: b.default, createdAt: b.created_at }))
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
    this.#listedAt = this.#now();
    this.#hosts.clear();
    return this.#branches;
  }

  /** The branch named `name`; refreshes once before giving up, so a new branch is found first try. */
  async byName(name: string): Promise<RadialBranch> {
    const found = (await this.list()).find(b => b.name === name)
      ?? (await this.refresh()).find(b => b.name === name);
    if (found === undefined) {
      throw new Error(`No Neon branch named "${name}". listBranches() has the current names.`);
    }
    return found;
  }

  /** The host of a branch's compute: its read-only endpoint when it has one, else the primary. */
  async host(branch: RadialBranch): Promise<string> {
    const cached = this.#hosts.get(branch.id);
    if (cached !== undefined) return cached;
    const { endpoints } = await this.#get<{ endpoints: NeonEndpointJson[] }>(
      `/branches/${encodeURIComponent(branch.id)}/endpoints`);
    const endpoint = endpoints.find(e => e.type === "read_only") ?? endpoints.find(e => e.type === "read_write");
    if (endpoint === undefined) {
      throw new Error(`Neon branch "${branch.name}" has no compute endpoint to connect to.`);
    }
    this.#hosts.set(branch.id, endpoint.host);
    return endpoint.host;
  }
}
