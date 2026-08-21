// One Cap'n Web session against the Workshop's /api, as the signed-in Access user, plus a local
// mirror of each opened workspace's Yjs document. The MCP tools in index.ts are thin projections of
// this class.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RpcStub, RpcTarget, newWebSocketRpcSession } from "capnweb";
import * as Y from "yjs";
import type {
  AuthenticatedApi, BlueprintGadgetSummary, CodeSubscriber, CodeUpdate, ConsoleLogEvent,
  ConsoleLogSubscriber, GadgetBindingInfo, GadgetClient, GadgetMetadataWithTimestamps, Overseer,
  PublicApi, WorkpieceId, WorkpieceSummary, WorkpiecesSubscriber,
} from "@gadgets/workshop-shared/api";

const execFileAsync = promisify(execFile);

export const ORIGIN = "https://radial.zone";
const WS_URL = "wss://radial.zone/api";

/**
 * The Access JWT for radial.zone, from cloudflared's per-user cache (`cloudflared access login
 * https://radial.zone` fills it). cloudflared re-prompts in the browser only when the cached token
 * has expired, so this is a cheap call.
 */
async function accessToken(): Promise<string> {
  const { stdout } = await execFileAsync("cloudflared", ["access", "token", "-app", ORIGIN]);
  const token = stdout.trim();
  if (!token.startsWith("eyJ")) {
    throw new Error(`cloudflared returned no token. Run: cloudflared access login ${ORIGIN}`);
  }
  return token;
}

/**
 * Wrap a callback target for the server. Minted through the same capnweb instance as the session:
 * a stub from a second install is unserialisable (`Cannot serialize value: [object RpcStub]`).
 */
function stubFor<T extends RpcTarget>(target: T): RpcStub<T> {
  return new RpcStub(target) as unknown as RpcStub<T>;
}

/** A console log line kept in the per-workspace ring buffer. */
export type LogLine = { seq: number; at: Date; chatId: number | null; level: string; message: unknown[] };

const LOG_RING = 1000;

class WorkpiecesMirror extends RpcTarget implements WorkpiecesSubscriber {
  readonly entries = new Map<WorkpieceId, WorkpieceSummary>();
  readonly isReady: Promise<void>;
  #resolveReady!: () => void;
  constructor() {
    super();
    this.isReady = new Promise(r => { this.#resolveReady = r; });
  }
  entry(summary: WorkpieceSummary) { this.entries.set(summary.id, summary); }
  removed(id: WorkpieceId) { this.entries.delete(id); }
  ready() { this.#resolveReady(); }
}

class CodeMirror extends RpcTarget implements CodeSubscriber {
  version = 0;
  readonly isReady: Promise<void>;
  #resolveReady!: () => void;
  #waiters: Array<{ above: number; resolve: (v: number) => void }> = [];
  readonly doc: Y.Doc;
  constructor(doc: Y.Doc) {
    super();
    this.doc = doc;
    this.isReady = new Promise(r => { this.#resolveReady = r; });
  }
  update(up: CodeUpdate) {
    // Synchronous apply keeps capnweb's in-order delivery meaningful.
    Y.applyUpdateV2(this.doc, up.update, "server");
    this.version = up.version;
    this.#waiters = this.#waiters.filter(w => {
      if (this.version > w.above) { w.resolve(this.version); return false; }
      return true;
    });
  }
  ready() { this.#resolveReady(); }
  /** Resolves with the first version above `above`, or the current version after `timeoutMs`. */
  versionAbove(above: number, timeoutMs = 3000): Promise<number> {
    if (this.version > above) return Promise.resolve(this.version);
    return new Promise(resolve => {
      const w = { above, resolve };
      this.#waiters.push(w);
      setTimeout(() => {
        this.#waiters = this.#waiters.filter(x => x !== w);
        resolve(this.version);
      }, timeoutMs).unref();
    });
  }
}

class LogRing extends RpcTarget implements ConsoleLogSubscriber {
  readonly lines: LogLine[] = [];
  #seq = 0;
  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    for (const l of logs) {
      this.lines.push({ seq: ++this.#seq, at: l.timestamp, chatId, level: l.level, message: l.message });
    }
    if (this.lines.length > LOG_RING) this.lines.splice(0, this.lines.length - LOG_RING);
  }
}

/** An opened workspace: its Overseer stub and the local mirror of its Yjs document. */
export class Workspace {
  readonly doc = new Y.Doc();
  readonly workpieces = new WorkpiecesMirror();
  readonly code = new CodeMirror(this.doc);
  readonly logs = new LogRing();
  readonly #subscriptions: RpcStub<{}>[] = [];
  readonly id: string;
  readonly overseer: RpcStub<Overseer>;

  constructor(id: string, overseer: RpcStub<Overseer>) {
    this.id = id;
    this.overseer = overseer;
  }

  async start(): Promise<void> {
    this.#subscriptions.push(
      await this.overseer.subscribeToWorkpieces(stubFor(this.workpieces)),
      await this.overseer.subscribeToCode(stubFor(this.code), 0),
      await this.overseer.subscribeToConsoleLogs(stubFor(this.logs)),
    );
    await Promise.all([this.workpieces.isReady, this.code.isReady]);
  }

  get version() { return this.code.version; }

  gadgets(): WorkpieceSummary[] {
    return [...this.workpieces.entries.values()].sort((a, b) => a.id - b.id);
  }

  gadget(id: WorkpieceId): WorkpieceSummary {
    const g = this.workpieces.entries.get(id);
    if (!g) throw new Error(`No gadget ${id} in workspace ${this.id}. Known: ${this.gadgets().map(g => g.id).join(", ") || "none"}`);
    return g;
  }

  /** The gadget's file map. Throws for a gadget that owns no files. */
  files(gadgetId: WorkpieceId): Y.Map<Y.Text> {
    const g = this.gadget(gadgetId);
    if (g.filesRoot === undefined) throw new Error(`Gadget ${gadgetId} ("${g.title}") owns no files.`);
    return this.doc.getMap<Y.Text>(g.filesRoot);
  }

  listFiles(gadgetId: WorkpieceId): string[] {
    return [...this.files(gadgetId).keys()].sort();
  }

  readFile(gadgetId: WorkpieceId, filename: string): string | null {
    const text = this.files(gadgetId).get(filename);
    return text === undefined ? null : text.toString();
  }

  /**
   * Apply `mutate` to the local doc as one transaction and send the resulting V2 update to the
   * server. Without `chatId` the edit lands on committed mainline; with it, the edit is a draft
   * proposed in that chat (accepted or reverted in the UI). Resolves with the new code version once
   * the server has echoed it back.
   */
  async commit(mutate: () => void, chatId?: number): Promise<number> {
    const before = this.code.version;
    let update: Uint8Array | undefined;
    const capture = (u: Uint8Array, origin: unknown) => { if (origin === "local") update = u; };
    this.doc.on("updateV2", capture);
    try {
      this.doc.transact(mutate, "local");
    } finally {
      this.doc.off("updateV2", capture);
    }
    if (update === undefined) return before; // no-op edit
    await this.overseer.updateCode(update, chatId);
    return this.code.versionAbove(before);
  }

  writeFile(gadgetId: WorkpieceId, filename: string, content: string, chatId?: number): Promise<number> {
    const files = this.files(gadgetId);
    return this.commit(() => {
      const existing = files.get(filename);
      if (existing === undefined) {
        const text = new Y.Text();
        text.insert(0, content);
        files.set(filename, text);
      } else {
        // Delete+insert, like the in-product agent's writeFile.
        existing.delete(0, existing.length);
        existing.insert(0, content);
      }
    }, chatId);
  }

  /** Exact-match replace, like the in-product agent's editFile: `oldText` must occur exactly once. */
  editFile(gadgetId: WorkpieceId, filename: string, oldText: string, newText: string, chatId?: number)
      : Promise<number> {
    const files = this.files(gadgetId);
    const text = files.get(filename);
    if (text === undefined) throw new Error(`No file "${filename}" in gadget ${gadgetId}.`);
    const current = text.toString();
    const first = current.indexOf(oldText);
    if (first < 0) throw new Error(`oldText not found in "${filename}".`);
    if (current.indexOf(oldText, first + 1) >= 0) {
      throw new Error(`oldText occurs more than once in "${filename}"; include more context.`);
    }
    return this.commit(() => {
      text.delete(first, oldText.length);
      text.insert(first, newText);
    }, chatId);
  }

  deleteFile(gadgetId: WorkpieceId, filename: string, chatId?: number): Promise<number> {
    const files = this.files(gadgetId);
    if (!files.has(filename)) throw new Error(`No file "${filename}" in gadget ${gadgetId}.`);
    return this.commit(() => { files.delete(filename); }, chatId);
  }

  async createGadget(title: string, bindingName?: string, chatId?: number): Promise<WorkpieceSummary> {
    const client = await this.overseer.createGadget(title, chatId, bindingName);
    const id = await client.getId();
    client[Symbol.dispose]();
    // The workpieces subscription delivers the new entry asynchronously; wait for it briefly.
    for (let i = 0; i < 40 && !this.workpieces.entries.has(id); i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    return this.gadget(id);
  }

  gadgetClient(id: WorkpieceId): Promise<RpcStub<GadgetClient>> {
    this.gadget(id);
    return this.overseer.getGadget(id);
  }

  /**
   * The gatekeeper workpieces in this workspace (connections, ambient capsules such as the Radial
   * database). The Workshop publishes no list of them, but gadget and gatekeeper ids come from one
   * counter, so probing every id up to a little past the highest known gadget finds them all.
   */
  async listGatekeepers(): Promise<Array<{ id: WorkpieceId; title: string; url: string; suggestedBindingName?: string }>> {
    const maxGadget = Math.max(0, ...this.gadgets().map(g => g.id));
    const gadgetIds = new Set(this.gadgets().map(g => g.id));
    const found: Array<{ id: WorkpieceId; title: string; url: string; suggestedBindingName?: string }> = [];
    for (let id = 1; id <= maxGadget + 8; id++) {
      if (gadgetIds.has(id)) continue;
      try {
        const gk = await this.overseer.getGatekeeperById(id);
        const d = await gk.describe();
        found.push({ id, title: d.title, url: d.url, suggestedBindingName: d.suggestedBindingName });
      } catch {
        // not a gatekeeper id
      }
    }
    return found;
  }

  async listBindings(id: WorkpieceId, chatId?: number): Promise<GadgetBindingInfo[]> {
    using client = await this.gadgetClient(id);
    return client.listBindings(chatId);
  }

  async bind(id: WorkpieceId, name: string, target: WorkpieceId, chatId?: number): Promise<void> {
    using client = await this.gadgetClient(id);
    await client.bind(name, target, chatId);
  }

  async unbind(id: WorkpieceId, name: string): Promise<void> {
    using client = await this.gadgetClient(id);
    await client.unbind(name);
  }

  async createBlueprint(id: WorkpieceId, title?: string, description?: string)
      : Promise<BlueprintGadgetSummary> {
    using client = await this.gadgetClient(id);
    return client.createBlueprint(title, description);
  }

  /** Bundle version as a liveness probe: it moves when the gadget's worker was rebuilt. */
  async uiBundleSize(id: WorkpieceId, chatId?: number): Promise<number | null> {
    using client = await this.gadgetClient(id);
    const bundle = await client.getUiBundle(chatId);
    return bundle === null ? null : bundle.jsCode.length;
  }

  async callGadget(id: WorkpieceId, method: string, args: unknown[], chatId?: number): Promise<unknown> {
    using client = await this.gadgetClient(id);
    using gadget = await client.connectToGadget(chatId);
    // The gadget's interface is whatever server.js exports; the stub is untyped by design.
    const fn: unknown = Reflect.get(gadget, method);
    if (typeof fn !== "function") throw new Error(`Gadget ${id} has no method "${method}".`);
    return await Reflect.apply(fn, gadget, args);
  }

  logsSince(seq: number, chatId?: number | null): LogLine[] {
    return this.logs.lines.filter(l => l.seq > seq && (chatId === undefined || l.chatId === chatId));
  }

  close() {
    for (const s of this.#subscriptions) {
      try { s[Symbol.dispose](); } catch { /* already broken */ }
    }
    this.overseer[Symbol.dispose]();
    this.doc.destroy();
  }
}

/** The authenticated session. Reconnects lazily after the socket breaks. */
export class Session {
  #api: RpcStub<AuthenticatedApi> | undefined;
  #broken: unknown = undefined;
  readonly #workspaces = new Map<string, Workspace>();

  async api(): Promise<RpcStub<AuthenticatedApi>> {
    if (this.#api !== undefined && this.#broken === undefined) return this.#api;
    if (this.#api !== undefined) {
      // Everything minted on the old socket is dead.
      for (const w of this.#workspaces.values()) w.close();
      this.#workspaces.clear();
      this.#api = undefined;
    }
    const token = await accessToken();
    // Node's built-in WebSocket (undici) takes upgrade headers through a non-standard init object
    // that the standard typings don't declare. Access accepts the user JWT as `cf-access-token`;
    // the Workshop additionally requires a same-origin `Origin`.
    const NodeWebSocket = WebSocket as unknown as
        new (url: string, init: { headers: Record<string, string> }) => WebSocket;
    const socket = new NodeWebSocket(WS_URL, { headers: { Origin: ORIGIN, "cf-access-token": token } });
    const publicApi = newWebSocketRpcSession<PublicApi>(socket);
    const api = await publicApi.authenticateFromCfAccess();
    this.#broken = undefined;
    api.onRpcBroken(err => { this.#broken = err ?? new Error("RPC broken"); });
    this.#api = api;
    return api;
  }

  async whoami() {
    const api = await this.api();
    return api.whoami();
  }

  async listWorkspaces(): Promise<GadgetMetadataWithTimestamps[]> {
    const api = await this.api();
    return api.listGadgets();
  }

  async workspace(id: string): Promise<Workspace> {
    const api = await this.api();
    const existing = this.#workspaces.get(id);
    if (existing !== undefined) return existing;
    const overseer = await api.openGadget(id);
    const ws = new Workspace(id, overseer);
    await ws.start();
    this.#workspaces.set(id, ws);
    return ws;
  }

  async newWorkspace(title?: string): Promise<Workspace> {
    const api = await this.api();
    const overseer = await api.newGadget();
    if (title !== undefined) await overseer.setTitle(title);
    const meta = await overseer.getMetadata();
    const ws = new Workspace(meta.id, overseer);
    await ws.start();
    this.#workspaces.set(meta.id, ws);
    return ws;
  }
}
