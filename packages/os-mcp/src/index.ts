#!/usr/bin/env node
// Radial OS authoring MCP server (stdio). Every tool is a projection of Session; see session.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Session } from "./session.ts";

const session = new Session();
const server = new McpServer({ name: "radial-os", version: "1.0.0" });

const workspace = z.string().describe("Workspace id (from list_workspaces or new_workspace)");
const gadget = z.number().int().describe("Gadget workpiece id (from list_gadgets)");
const draft = z.number().int().optional().describe(
    "Chat id. When set, the change is a draft proposed in that chat (accepted or reverted in the UI). "
    + "Omit to write to committed mainline.");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** Run a tool body; an exception becomes an MCP error result instead of a protocol failure. */
function tool<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async args => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    }
  };
}

server.registerTool("whoami", {
  description: "The Radial OS identity this server acts as (the signed-in Cloudflare Access user).",
  inputSchema: {},
}, tool(async () => json(await session.whoami())));

server.registerTool("list_workspaces", {
  description: "List the user's Radial OS workspaces (id, title, timestamps). A workspace holds one or more gadgets.",
  inputSchema: {},
}, tool(async () => {
  const list = await session.listWorkspaces();
  return json(list.map(w => ({ id: w.id, title: w.title, created: w.created, lastActive: w.lastActive, role: w.role ?? "build" })));
}));

server.registerTool("new_workspace", {
  description: "Create a new, empty workspace. Returns its id. Create a gadget in it next with create_gadget.",
  inputSchema: { title: z.string().optional().describe("Workspace title") },
}, tool(async ({ title }) => {
  const ws = await session.newWorkspace(title);
  return json({ id: ws.id, version: ws.version });
}));

server.registerTool("list_gadgets", {
  description: "List the gadgets in a workspace: id, title, whether it owns files, and its files. Opens the workspace (subscribes to its code and console) if not already open.",
  inputSchema: { workspace },
}, tool(async ({ workspace: id }) => {
  const ws = await session.workspace(id);
  return json({
    version: ws.version,
    gadgets: ws.gadgets().map(g => ({
      id: g.id, title: g.title, output: g.output, draftOfChat: g.chatId,
      files: g.filesRoot === undefined ? null : ws.listFiles(g.id),
    })),
  });
}));

server.registerTool("read_file", {
  description: "Read one file of a gadget (server.js, client.js, README.md, ...).",
  inputSchema: { workspace, gadget, filename: z.string() },
}, tool(async ({ workspace: id, gadget: g, filename }) => {
  const ws = await session.workspace(id);
  const content = ws.readFile(g, filename);
  if (content === null) throw new Error(`No file "${filename}". Files: ${ws.listFiles(g).join(", ") || "none"}`);
  return text(content);
}));

server.registerTool("write_file", {
  description: "Create or overwrite one file of a gadget. Returns the new code version. Prefer edit_file for small changes.",
  inputSchema: { workspace, gadget, filename: z.string(), content: z.string(), draft },
}, tool(async ({ workspace: id, gadget: g, filename, content, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json({ version: await ws.writeFile(g, filename, content, chatId) });
}));

server.registerTool("edit_file", {
  description: "Replace one exact occurrence of oldText with newText in a gadget file. Fails if oldText is absent or ambiguous. Read the file first. Returns the new code version.",
  inputSchema: { workspace, gadget, filename: z.string(), oldText: z.string(), newText: z.string(), draft },
}, tool(async ({ workspace: id, gadget: g, filename, oldText, newText, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json({ version: await ws.editFile(g, filename, oldText, newText, chatId) });
}));

server.registerTool("delete_file", {
  description: "Delete one file of a gadget. Returns the new code version.",
  inputSchema: { workspace, gadget, filename: z.string(), draft },
}, tool(async ({ workspace: id, gadget: g, filename, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json({ version: await ws.deleteFile(g, filename, chatId) });
}));

server.registerTool("create_gadget", {
  description: "Create an empty gadget in a workspace. Then write server.js (export class Gadget extends DurableObject) and client.js. bindingName is the name other gadgets and chats see it under; the server picks one from the title when omitted.",
  inputSchema: { workspace, title: z.string(), bindingName: z.string().optional(), draft },
}, tool(async ({ workspace: id, title, bindingName, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json(await ws.createGadget(title, bindingName, chatId));
}));

server.registerTool("list_bindings", {
  description: "List a gadget's bindings: the names in its env and the gatekeeper each points at.",
  inputSchema: { workspace, gadget, draft },
}, tool(async ({ workspace: id, gadget: g, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json(await ws.listBindings(g, chatId));
}));

server.registerTool("list_gatekeepers", {
  description: "List the gatekeeper workpieces in a workspace (e.g. the Radial database, id + suggested binding name). Use the id as bind's target.",
  inputSchema: { workspace },
}, tool(async ({ workspace: id }) => {
  const ws = await session.workspace(id);
  return json(await ws.listGatekeepers());
}));

server.registerTool("bind", {
  description: "Bind a gatekeeper workpiece into a gadget's env under a name. Fails if the name is taken or invalid.",
  inputSchema: { workspace, gadget, name: z.string(), target: z.number().int().describe("Gatekeeper workpiece id"), draft },
}, tool(async ({ workspace: id, gadget: g, name, target, draft: chatId }) => {
  const ws = await session.workspace(id);
  await ws.bind(g, name, target, chatId);
  return json(await ws.listBindings(g, chatId));
}));

server.registerTool("unbind", {
  description: "Remove a binding from a gadget's env.",
  inputSchema: { workspace, gadget, name: z.string() },
}, tool(async ({ workspace: id, gadget: g, name }) => {
  const ws = await session.workspace(id);
  await ws.unbind(g, name);
  return json(await ws.listBindings(g));
}));

server.registerTool("list_blueprints", {
  description: "List the blueprints published from a workspace's gadgets.",
  inputSchema: { workspace },
}, tool(async ({ workspace: id }) => {
  const ws = await session.workspace(id);
  return json(await ws.overseer.listBlueprints());
}));

server.registerTool("create_blueprint", {
  description: "Publish a gadget's committed code as a new blueprint (a reusable, versioned template). Returns the blueprint summary.",
  inputSchema: { workspace, gadget, title: z.string().optional(), description: z.string().optional() },
}, tool(async ({ workspace: id, gadget: g, title, description }) => {
  const ws = await session.workspace(id);
  return json(await ws.createBlueprint(g, title, description));
}));

server.registerTool("update_blueprint", {
  description: "Update a blueprint: retitle/redescribe, and/or snapshot the source gadget's current committed code as a new blueprint version (updateCode), and/or refresh binding annotations (updateBindings).",
  inputSchema: {
    workspace, blueprintId: z.string(),
    title: z.string().optional(), description: z.string().optional(),
    updateCode: z.boolean().optional(), updateBindings: z.boolean().optional(),
  },
}, tool(async ({ workspace: id, blueprintId, ...options }) => {
  const ws = await session.workspace(id);
  await ws.overseer.updateBlueprint(blueprintId, options);
  return json((await ws.overseer.listBlueprints()).find(b => b.id === blueprintId) ?? { id: blueprintId });
}));

server.registerTool("console_logs", {
  description: "Console output from the workspace's gadget workers, collected since the workspace was opened in this session. Pass the last seq you saw to get only newer lines.",
  inputSchema: {
    workspace,
    since: z.number().int().optional().describe("Return lines with seq greater than this"),
    draft: z.number().int().nullable().optional().describe("Filter by chat id; null = committed code only"),
  },
}, tool(async ({ workspace: id, since, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json(ws.logsSince(since ?? 0, chatId));
}));

server.registerTool("gadget_status", {
  description: "Liveness probe for a gadget: the workspace code version and the size of its built UI bundle (null = no client.js built yet). The bundle changes when the gadget was rebuilt.",
  inputSchema: { workspace, gadget, draft },
}, tool(async ({ workspace: id, gadget: g, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json({ version: ws.version, uiBundleBytes: await ws.uiBundleSize(g, chatId) });
}));

server.registerTool("call_gadget", {
  description: "Call a method on a gadget's server-side Durable Object (the class exported from server.js) and return its result.",
  inputSchema: { workspace, gadget, method: z.string(), args: z.array(z.unknown()).optional(), draft },
}, tool(async ({ workspace: id, gadget: g, method, args, draft: chatId }) => {
  const ws = await session.workspace(id);
  return json(await ws.callGadget(g, method, args ?? [], chatId));
}));

await server.connect(new StdioServerTransport());
