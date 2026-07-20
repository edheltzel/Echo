# RedTeam Verdicts — Pi SDK Tool Registration + Claude Code Hooks (voice_ask scoping)

Adversarial validation pass for Themis. All evidence is primary, read from the
installed SDKs on this machine (2026-07-13). Read-only except this file.

## Environment (what's actually installed)

| Runtime | Package | Version | Path |
|---|---|---|---|
| Upstream Pi | `@earendil-works/pi-coding-agent` | 0.78.1 | `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent` |
| oh-my-pi (fork) | `@oh-my-pi/pi-coding-agent` | 16.4.8 | `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` |
| `pi` bin | → `~/.vite-plus/bin/pi` | | |
| `omp` bin | → `~/.bun/bin/omp` | | |

Echo's Pi adapter (`/Users/ed/Developer/atlasEcho/adapters/pi/index.ts`) imports
`ExtensionAPI` from `@earendil-works/pi-coding-agent` and its `atlasVoicePiAdapter(pi: ExtensionAPI, …)`
factory already calls `pi.on(...)` and `pi.registerCommand(...)` on that exact object.
The interface it receives is the one verified below.

---

## (a) Pi tool registration: **SUPPORTED** (both runtimes)

A Pi / oh-my-pi extension CAN register a **model-invokable tool**, not merely a slash command.
This is a first-class, documented method on the same `ExtensionAPI` object Echo already uses.

**Upstream Pi** — `dist/core/extensions/types.d.ts`:

- File header (lines 1–9): "Extensions are TypeScript modules that can: … **Register LLM-callable tools** … Register commands, keyboard shortcuts, and CLI flags".
- `ExtensionAPI` (line 790) exposes, line 820–821:
  ```ts
  /** Register a tool that the LLM can call. */
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
  ```
- `ToolDefinition` (line 333) carries the full model-invokable shape: `name` ("used in LLM tool calls"), `description` ("Description for LLM"), `parameters` (TypeBox schema), and an
  ```ts
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>
  ```
  (line 359) whose return value is the tool result surfaced back to the model.
- Same file also exports `defineTool(...)` (line 373) and `CreateAgentSessionOptions.customTools: ToolDefinition[]` (sdk.d.ts line 48) — a second registration path.

**oh-my-pi** — `dist/types/extensibility/extensions/types.d.ts` (the type `registerTool` actually accepts):
- `ExtensionAPI` (line 670), line 723–724:
  ```ts
  /** Register a tool that the LLM can call. */
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
  ```
- Its `ToolDefinition.execute` (line 383) — the model-facing handler `registerTool` accepts:
  ```ts
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>
  ```

**Demonstrated, not just typed:** the shipped `@earendil-works` package ships working extensions that
call it — `examples/extensions/minimal-mode.ts` (7 `pi.registerTool({...})` calls) and
`examples/extensions/ssh.ts` (3). The runtime implementation lives in
`dist/core/extensions/loader.js`. So (a) is demonstrated, not inferred from a `.d.ts` contract alone.
(oh-my-pi's `registerTool` verdict rests on its published type contract; it is a fork of the same
extension system.)

**Cross-runtime portability — verified, and it is clean.** The load-bearing question for a
write-once-run-both `voice_ask` tool is whether `ToolDefinition.execute` has the same argument order
on both runtimes. It does:
- Upstream Pi `ToolDefinition.execute` (types.d.ts line 359): `(toolCallId, params, signal, onUpdate, ctx)`
- oh-my-pi `ToolDefinition.execute` (types.d.ts line 383): `(toolCallId, params, signal, onUpdate, ctx)` — **identical arg order.**

The only shape delta is a third generic on upstream (`TState`, used by `renderCall`) that oh-my-pi
drops, plus a slightly different `renderCall` signature — neither touches `execute` or the tool's
model-facing contract (`name`/`description`/`parameters`/`execute` return). A single `voice_ask`
implementation typed against `@earendil-works` `ToolDefinition` therefore has `signal`/`onUpdate`/`ctx`
in the correct positions under omp too.

  ⚠ Do **not** confuse this with oh-my-pi's *separate* file-based `CustomTool` path
  (`dist/types/extensibility/custom-tools/types.d.ts` line 203), whose `execute` reorders to
  `(toolCallId, params, onUpdate, ctx, signal)` — `signal` last. That is the `.pi/tools` file-loader
  type, **not** what `registerTool` accepts, and Echo would not use it. Only `registerTool`'s
  `ToolDefinition` is relevant, and that one matches upstream.

**Cross-check vs Echo's adapter:** The `pi` argument Echo's factory receives is exactly this
`ExtensionAPI`. Echo currently only uses `pi.on(...)` (lifecycle events) and `pi.registerCommand(...)`
(the `voice-status` slash command). `registerTool` sits on the *same object* — reaching the Pi model
with a `voice_ask` tool needs no new plumbing, no MCP, just an added `pi.registerTool({...})` call in
the existing adapter, with a single `execute` implementation valid on both runtimes.

**Verdict: SUPPORTED.** The existing extension adapter is sufficient; MCP is not required for Pi.

---

## (b) Pi / omp MCP support: **split — upstream Pi NO, oh-my-pi YES**

- **Upstream Pi (`@earendil-works` 0.78.1): NO native MCP.** `docs/usage.md` line 286 (verbatim):
  "It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos,
  or background bash. You can build or install those workflows as extensions or packages…". No `mcp`
  identifiers anywhere in its `.d.ts` surface.
- **oh-my-pi (`@oh-my-pi` 16.4.8): YES, native MCP.** `dist/types/sdk.d.ts`:
  - line 17 `import { MCPManager, type MCPToolsLoadResult } from "./mcp/index.js";`
  - lines 140–143 `enableMCP?: boolean` ("Enable MCP server discovery from .mcp.json files. Default: true"), `mcpManager?: MCPManager`
  - line 239 re-exports `MCPManager, MCPServerConfig, MCPServerConnection, MCPToolsLoadResult`
  - line 324 `export declare function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult>` — "Discover MCP servers from .mcp.json files."
  - oh-my-pi's `CustomTool` even has `mcpServerName` / original-MCP-tool-name metadata for tools that front an MCP server.

**Implication for Echo:** irrelevant to the decision, because the extension `registerTool` path (a)
works on *both* runtimes and is strictly simpler than standing up an MCP server. MCP would only matter
if Echo needed the Pi model to reach an out-of-process tool; `voice_ask` lives in-adapter, so the
extension path wins. (If MCP were ever wanted, it exists on oh-my-pi but not upstream Pi.)

**Verdict: YES on oh-my-pi, NO on upstream Pi — moot for voice_ask given (a).**

---

## (c) Claude Code hooks claim: **CONFIRMED** (with a precision correction)

Claim under test: "Claude Code hooks structurally cannot return a tool result to the model — MCP is
the only model-invokable path."

**Confirmed for the operative requirement**, i.e. *a model-invokable `voice_ask` tool whose return
value flows back to the model as a tool_result mid-turn*. Reasoning grounded in the hook I/O model
(`adapters/claudecode/hooks/VoiceGate.hook.ts`):

- The hook contract is **stdin JSON → stdout JSON verdict**. VoiceGate reads `HookInput` from
  `Bun.stdin.text()` and writes control-plane decisions: `{continue: true}` or
  `{decision: "block", reason: "..."}`. Hooks are **event-triggered on fixed lifecycle points**
  (PreToolUse, PostToolUse, Stop, SubagentStop, UserPromptSubmit, …).
- **Hooks are not a tool surface.** The model's tool list never contains a hook. The model cannot
  emit a `tool_use` block named `voice_ask` and have a hook service it, because hooks aren't
  registered as tools — they fire *reactively* to events keyed on tools the model already has
  (e.g. Bash) or to turn boundaries. There is no name the model can invoke to trigger a hook and
  await its return within a tool-call loop. That capability — a named tool the model chooses to
  call, whose handler return becomes the tool_result — is exactly what **MCP** (and equivalently a
  registered SDK tool, on Pi) provides, and hooks do not.

**Attempted refutation (and why it fails to overturn the claim):**

- *PreToolUse `reason` / `additionalContext`, PostToolUse `additionalContext`, UserPromptSubmit
  `additionalContext`, Stop-block `reason`* — these DO push text into the model's context. So the
  literal phrase "cannot return **anything** to the model" would be **too strong / false**: hooks are
  not mute. But every one of these is (1) not model-initiated — the model didn't ask — and (2) bound
  to a fixed event, not an arbitrary mid-turn question the model posed.
- *Stop / SubagentStop loop* — the closest thing to an ask→transcript→continue round trip: a Stop
  hook could capture a spoken transcript and return `{decision:"block", reason: <transcript>}`, which
  forces Claude to continue with that text injected. This is a **real round trip**, but it is
  **hook-initiated at the turn boundary**, not a mid-turn tool the model invoked, and it fires only
  when the model tries to *stop*, not when it *decides it needs an answer to proceed*. It's a
  workaround with different semantics, not the model-invokable `voice_ask` the design needs.

**Reconciled truth:** Claude Code hooks can *inject* text into the model at fixed lifecycle events,
but they cannot expose a **model-invokable tool** whose return value is delivered as a tool_result
inside the model's tool-call loop. For an interactive, model-initiated `voice_ask` (model asks →
spoken answer transcribed → returned to the model mid-turn as that tool's result), **MCP is the only
model-invokable path in Claude Code** — hooks structurally cannot do it. The claim stands; only its
absolute wording ("return a tool result … cannot") needs the nuance that hooks *can* inject context,
just never as a model-invoked tool call.

**The crux, stated plainly:** a hook can *intercept the model's existing tool calls and inject text
back* (block-reason, `additionalContext`), but it cannot *add a new named tool to the model's tool
list*. Only MCP does that in Claude Code. "Can a hook return text to the model?" → yes. "Can a hook be
a model-invokable tool?" → no. The claim survives only on the second question — which is the one the
`voice_ask` design actually asks.

**Verdict: CONFIRMED** (operative requirement), with the precision correction above.

---

## Bottom line for the scout's decisive question

- **Pi path:** Echo's *existing* extension adapter already holds the object that can register a
  model-invokable `voice_ask` tool (`pi.registerTool`) on **both** upstream Pi and oh-my-pi. No MCP
  needed for Pi.
- **Claude Code path:** the same reach requires **MCP** — hooks cannot expose a model-invokable tool.

So the two hosts are asymmetric: Pi via extension `registerTool`, Claude Code via MCP.
