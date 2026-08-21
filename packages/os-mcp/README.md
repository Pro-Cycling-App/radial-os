# os-mcp

A local stdio MCP server that lets Claude Code author Radial OS gadgets and blueprints over the
Workshop's Cap'n Web API (`wss://radial.zone/api`), as the signed-in Cloudflare Access user.

- Identity: `cloudflared access token -app https://radial.zone` (run `cloudflared access login
  https://radial.zone` once). The JWT goes on the WebSocket upgrade as `cf-access-token`, with
  `Origin: https://radial.zone`.
- State: one session, plus a local Yjs mirror of each opened workspace (`subscribeToCode`),
  so writes are small V2 updates sent with `Overseer.updateCode(update, chatId?)`. Without a
  `chatId` a write lands on committed mainline.
- Run: `node src/index.ts` (Node 24 type stripping; no build). The monorepo's `.mcp.json` points
  here by absolute path.
- Check: `pnpm --filter os-mcp types:check`.

Tools: `whoami`, `list_workspaces`, `new_workspace`, `list_gadgets`, `read_file`, `write_file`,
`edit_file`, `delete_file`, `create_gadget`, `list_bindings`, `bind`, `unbind`, `list_blueprints`,
`create_blueprint`, `update_blueprint`, `console_logs`, `gadget_status`, `call_gadget`.

The monorepo's `docs/os/gadgets.md` and the `os-gadget` skill describe the workflow.
