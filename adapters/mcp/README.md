# MCP adapter

An MCP server exposing echo's one-shot voice ask (`echo_ask`) to hosts that consume tools
over MCP. Claude Code is the reason it exists: its hooks are one-shot lifecycle
interceptors, so they can block, allow or inject context, but they cannot expose a tool the
model decides to call, and they have no channel for returning a transcript as a tool result.

```bash
bash scripts/install.sh --adapter mcp          # register in ~/.claude.json
bun adapters/mcp/reconcile.ts --check          # 0 current · 3 pending · 2 name collision
bun adapters/mcp/server.ts                     # serve MCP over stdio (hosts do this)
```

- **Transport:** newline-delimited JSON over stdio. `initialize`, `tools/list`, `tools/call`
  and `ping`; shapes pinned to the published MCP specification, replayed against a spawned
  process in `tests/adapters/mcp/`.
- **Registration:** `~/.claude.json` → `mcpServers["echo-converse"]`, reconcile-and-prune per
  the [#77 contract](../../docs/adapters.md#registration-contract--reconcile-and-prune-issue-77).
  Echo owns that one name; anything else holding it is FATAL rather than overwritten.
  `ECHO_MCP_CONFIG_PATH` redirects the target, which is how the tests stay off the real config.
- **Why the host launches it:** a stdio MCP server is the host's own child, so the capture
  child it spawns inherits the terminal's process ancestry and the microphone grant attributes
  to the terminal app. See [docs/converse.md](../../docs/converse.md).

The turn itself lives in `@echo/converse`; this package only speaks the wire protocol.
