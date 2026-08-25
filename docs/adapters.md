# Adapters

Adapters are out-of-process host integrations that translate host lifecycle events into
`POST /notify` calls. They import nothing from `core/` and speak only the HTTP contract. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the boundary and [`http-api.md`](http-api.md)
for the wire shape.

## Adapter rules

Adapters should:

1. Observe host lifecycle events.
2. Extract a short user-facing message (for Pi/Claude Code, the final `🗣️` line).
3. Add `source` and `session_id` metadata when available.
4. POST to the daemon's `/notify`, resolved via `shared/daemon-endpoints.ts`.
5. Treat notify failures as non-fatal host-session warnings.
6. Suppress child/subagent contexts to avoid audio floods.

## Package boundary - self-contained, HTTP-only

Every host adapter is a **workspace package** (`adapters/<host>/package.json`, listed in the
root `workspaces` array). Two rules make the boundary real rather than aspirational, and
both are machine-enforced in `tests/core/architecture-invariants.test.ts`:

1. **No import escapes the package root.** Relative imports stay inside `adapters/<host>/`.
   Shared behavior is imported by name from `@echo/shared` - the `shared/` workspace package,
   which every adapter declares in its own `dependencies`. `bun install` links it at
   `adapters/<host>/node_modules/@echo/shared`, so resolution works wherever the host loads
   the adapter from (repo path, foreign cwd, symlink, or bundled). A `../../shared/...`
   import is a boundary violation: it means the package cannot be reasoned about, moved, or
   packaged on its own.
2. **No adapter reads the daemon's files.** Configuration comes over the HTTP contract, never
   off disk. `GET /voices` reports the configured persona keys; `core/voices.json` is the
   daemon's private state. The daemon may run from a different clone or a different
   `VOICES_PATH`, so a co-located read is wrong even when it happens to work.

An import scan alone cannot enforce rule 2 - the violation it replaced was a `readFileSync`
of a path string, not an import - so the guard pairs an import check with a string scan for
`core/` paths in adapter sources.

`@echo/shared` is also the single owner of invariants both sides enforce: the edge-tts voice
grammar lives in `shared/edge-voice.ts` and `core/server.ts` imports it, rather than each
keeping a copy in sync. `shared/` may never import `core/` - core imports shared, so the
dependency runs one way only.

## Registration contract - reconcile and prune (issue #77)

Every adapter MUST ship an **idempotent reconcile-and-prune registration** for whatever host
config holds its repo paths. Append-only registration is forbidden: a repo directory rename
leaves the old path behind, and the failure is silent on hosts that skip a missing package
(Pi) and loud on hosts that execute the registered path (Claude Code). Both happened in
production on 2026-07-02.

A conforming registration:

1. **Sets the required path explicitly** - derives the canonical path from the adapter's own
   location (`import.meta.url`), never from a hardcoded clone location.
2. **Prunes stale variants** - removes or replaces in place any registration that matches the
   adapter's pattern but is not the canonical path (dead paths from a rename, duplicates from
   append-style installs).
3. **Is idempotent** - rerunning against an already-correct config is a byte-for-byte no-op.
4. **Supports `--check`** - reports pending changes (including stale paths) without mutating,
   exiting 0 when current and 3 when changes are pending (machine-checkable).
5. **Edits through symlinks** - if the host config may be a symlink (e.g. into a dotfiles
   repo), write by atomically replacing the resolved real file, never the symlink itself.

Existing implementations to copy: `adapters/claudecode/restore-hooks.ts` (hook entries in
`~/.claude/settings.json`), `adapters/pi/reconcile.ts` (packages entry in
`~/.pi/agent/settings.json`), and `adapters/omp/reconcile.ts` (the `echo-voice` symlink in
`~/.omp/agent/extensions/`, #18/#109). `scripts/install.sh` re-reconciles **every installed
adapter on every run** regardless of `--adapter`, and `scripts/install.sh --check` aggregates
the adapters' check modes plus the LaunchAgent plist paths - a new adapter must plug its
reconcile and check commands into both. Future hosts (Codex/OpenCode #30) inherit this
contract.

## Native terminal visuals

Pi, omp, Claude Code, Jcode, and Grok adapters use the shared notify client for visual delivery. Before the
HTTP POST, it tries Herdr's `notification.show` when a documented Herdr context is present,
then the adapter-owned controlling TTY. The TTY route is deliberately conservative: it never
adopts arbitrary `stdout`/`stderr`, never performs focus-stealing actions, and requires tmux
`allow-passthrough` to be read as `on` or `all` before wrapping the OSC sequence. SSH/headless
contexts and unsupported terminals fall through to the daemon's normal AppleScript banner.

The terminal protocol matrix, the tmux passthrough contract, and the exact
`visual_delivery: "native"` marker rule are maintained in
[Native terminal visual delivery](http-api.md#native-terminal-visual-delivery). Adapter
diagnostics expose the selected route in `NotifyResult.visual`.

The MCP adapter is intentionally not in this path: it exposes an `echo_ask` tool for Claude
Code rather than a lifecycle notification hook.

## Jcode adapter - lifecycle hooks

Jcode exposes detached `session_start` and `turn_end` observer commands through its `[hooks]`
TOML section. `adapters/jcode/hook.ts` translates those events into `/notify` calls with
`source: "jcode"` and the Jcode session id. Successful turns speak only an explicit final
`🗣️ Name: summary` line from the tail-safe `JCODE_HOOK_LAST_ASSISTANT_TEXT` field.

Jcode's lifecycle stream covers TUI, desktop, headless, and swarm workers. The adapter uses
`JCODE_HOOK_SESSION_KIND` and `JCODE_HOOK_PARENT_SESSION_ID` to suppress child sessions.
Startup greetings are disabled by default; when enabled they run only for root
`session_start` events whose source is `create`, never attach/resume. Ordinary assistant text
is never read aloud. Jcode supports only one command per hook key; reconciliation refuses to
overwrite a non-Echo owner, quotes checkout paths for Jcode's shell-style command parser, and
fails closed on TOML table shapes it cannot preserve safely.

## Grok Build adapter - lifecycle hooks

Grok Build exposes global hooks under `~/.grok/hooks/*.json` (always trusted; project-local
hooks need a per-repo trust grant). `adapters/grok/hook.ts` reads Grok's camelCase hook JSON
from stdin and translates events into `/notify` with `source: "grok"` and the Grok session id.

- **Stop** fires for genuine turn ends (`reason == "end_turn"`) and also as a session-end
  observe fire (`shutdown` / `channel_closed`). Echo speaks only `end_turn`, using an explicit
  final `🗣️ Name: summary` line when present and a short fallback summary of
  `lastAssistantMessage` otherwise.
- **SubagentStop** is ignored so a fan-out does not produce a storm of spoken lines.
- **SessionStart** greetings are opt-in (`ECHO_VOICE_GREET_ON_START`); only new sessions
  (`source` of `new` / `startup` / `create`) greet. Captured against grok 1.0.0 where
  `source` is `"new"`.
- **Voice:** `voice_id` defaults to `"grok"` (`ECHO_VOICE_ID` overrides), resolved by the daemon
  through `agents.grok` in `core/voices.json`. That file is read once at startup from the staged
  payload, so a fresh `agents` entry needs a re-stage before it resolves - see
  [Which config changes need a re-stage](operations.md#which-config-changes-need-a-re-stage).
- **Registration:** one Echo-owned file `~/.grok/hooks/echo-voice.json` via
  `adapters/grok/reconcile.ts`. Sibling files (for example firstmate's `fm-turn-end.json`) are
  never rewritten or pruned. `GROK_HOME` / `ECHO_GROK_HOOKS_DIR` redirect the target for tests.
  Wired into `install.sh` as `--adapter grok`.

Fixtures under `tests/adapters/grok/fixtures/` were captured from the installed
`grok 1.0.0` CLI; where public docs and the installed surface disagree, the installed
surface wins.

## Live-session voice suppression - omp and Codex

Live mode is an adapter-local suppression state, not a daemon mute. omp marks only the
session whose public custom message has `role: "custom"` and
`customType: "live-delegation"`. While marked it suppresses the **notification** - the
`/notify` POST, and with it the native terminal banner that rides the same call. It still
injects the completion voice instruction, so the first turn after live mode ends carries its
own `🗣️` line.

**omp emits no live-end signal** - its live controller stops without putting anything on the
extension bus - so the mark is released by inference, three ways:

- the next turn-triggering message that is not a live delegation: `role: "user"`, or
  `role: "custom"` with any other `customType`. Typed user messages are not the only way a
  turn starts; prewalk, advisor and session-stop continuations all trigger turns with
  `role: "custom"`, and releasing only on `role: "user"` left those turns silent. Assistant
  and tool messages are excluded because they occur inside the delegation's own turn. A
  steered custom message can therefore release mid-turn - that direction is fail-open.
- a cap of 10 minutes since the most recent delegation (`LIVE_MODE_MAX_SILENCE_MS`,
  refreshed by each one), so suppression can never be unbounded.
- `session_shutdown`, which forgets the session entirely.

`echo_ask` is reported as unavailable while a session is marked, and refuses before consent:
omp's live conversation already owns the microphone that a spoken ask would open.

Codex reads the matching `turn_context` record from the hook payload's transcript and skips
that turn when `realtime_active` is `true`. The match is on `turn_id`, never on the newest
record, so a live turn cannot silence the rest of the session; missing or unreadable metadata
leaves ordinary notification behavior unchanged. Codex needs no release rule because the hook
is a fresh process per turn and holds no state.

Neither adapter calls `/mute` or changes the daemon's mute state. Other concurrent sessions
continue posting their notifications normally.

## Pi adapter - per-turn completions (issue #15)

Pi's own models don't emit the `🗣️` voice line on their own, so the Pi adapter **injects** the
convention. On `before_agent_start` (`adapters/pi/index.ts`) it appends an instruction to the
chained `event.systemPrompt` (feature-detected; falls back to `systemPromptAppend`; no-ops on
older runtimes) telling the model to end each response with `🗣️ <Name>: <8-16 word
summary>`. The existing `message_end`/`turn_end` path then extracts and speaks that line - so
Pi speaks per-turn completions like the Claude Code path, not just the startup greeting.

- **Persona name** comes from config: `personaName` ← `ECHO_VOICE_PERSONA_NAME` (default
  `"Pi"`), never hard-coded. Pi/omp resolve configuration exactly as the daemon does, so
  `~/.config/echo/config.json` is the durable local configuration surface and wins over
  the one-release environment fallback; an existing host process must be relaunched after edits.
- **Startup greeting (#81):** each user-visible `session_start` speaks a random pick from a
  pool of neutral catchphrases (`adapters/pi/config.ts`, mirroring the Claude Code adapter's
  `startupCatchphrases`). Configuring `ECHO_VOICE_CATCHPHRASE` in config.json replaces the
  pool with that single line; setting `ECHO_VOICE_GREET_ON_START` there to `false` disables it.
- **Distinct voice (issue #76, retuned in #81):** `voiceId` defaults to `"pi"`
  (`ECHO_VOICE_ID` in config.json overrides), which the daemon resolves via `agents.pi` in `core/voices.json`
  → `en-GB-RyanNeural` at speed `0.92` (edge-tts rate `-8%` via `core/edge-rate.ts`). Unlike
  the injection feature above, #76 also touched `core/voices.json` data - a running daemon
  loads voices.json once at startup, from its staged payload, so run `cli/echo update` to
  pick up the `pi` entry; until then the adapter's `voice_id: "pi"` is unresolvable and falls
  back to the provider default voice (audibly the identity voice on stock installs), logged
  as `resolution: fallback`.
- Injection is gated on `config.speakCompletions` (default on) **and** the same
  `shouldSuppressVoice` check the speak side uses (headless/subagent stays silent).
- `extractVoiceLineFromText` (`shared/voice-line.ts`) strips an optional leading
  `<Name>:` (mirroring the Claude Code adapter's `parseFinalVoiceLine` name grammar) so the persona name isn't
  spoken aloud.
- The injection feature itself (#15) is adapter-only: no `core/` or daemon change; the daemon
  already resolves `voice_id` name keys.

The full design rationale is catalogued in
[`design-docs/pi-completion-injection.md`](design-docs/pi-completion-injection.md).

## MCP adapter - Claude Code's route to a model-invokable tool

`adapters/mcp/` is an MCP server exposing the `echo_ask` tool (the one-shot voice ask; see
[converse.md](converse.md)). It exists because a Claude Code hook structurally cannot do this
job: a hook is a one-shot subprocess that reads one JSON blob, writes one verdict and exits, so
it can block, allow or inject context, but it is not model-invokable and has no channel for
handing a transcript back as a tool result.

- **Transport:** newline-delimited JSON over stdio; `initialize`, `tools/list`, `tools/call`,
  `ping`. Hand-written against the published MCP specification rather than an SDK, and replayed
  against a spawned process in `tests/adapters/mcp/`.
- **The tool itself is shared**, not reimplemented: `@echo/converse/host-tool.ts` owns the name,
  schema, description and behavior, so this server, the Pi adapter and the omp adapter cannot
  drift into three different tools.
- **Registration:** `~/.claude.json` -> `mcpServers["echo-converse"]`, reconcile-and-prune per
  the contract above, wired into `install.sh` as `--adapter mcp` (preflight, install, `--check`).
  Ownership is strict like omp's: echo owns that one name, a foreign server holding it is FATAL
  rather than overwritten, and an echo registration hiding under a different name is pruned so no
  session sees the tool twice. `ECHO_MCP_CONFIG_PATH` redirects the target for tests.
- **Why the host launches it:** capture must stay caller-side rather than in Echo's background
  coordinator. The measured direct-terminal path attributes to the terminal. Claude Code's stdio
  MCP path is expected to preserve that ancestry but remains unverified; turns record the observed
  chain, and source checks do not turn the expectation into runtime enforcement.

## Pi and omp: the `echo_ask` tool (two-way voice)

Both Pi runtimes can expose model-invokable tools, so both adapters register `echo_ask` through
`registerEchoAskTool` from `@echo/converse/host-tool.ts`. Three details were pinned against the
installed SDK rather than assumed, and each would have been a silent break:

- The runtime calls `execute(toolCallId, params, signal, onUpdate, ctx)`. The shipped
  `api-demo.ts` example names the arguments in a different order; the extension tool wrapper that
  actually calls it is authoritative. omp's separate file-based `CustomTool` type does use the
  other order, which is one more reason not to use it here.
- `parameters` accepts plain JSON Schema (a first-class `kind: "json"` branch alongside Zod and
  ArkType), so neither adapter needs a schema library or `pi.zod`.
- Registration is **feature-detected**. A runtime without the tool API loses the ask tool and
  keeps its voice notifications, instead of taking the whole extension down on load.

The adapters contribute only their host tag (`source`) and a per-call persona voice resolved from
the host context, so a project-local persona still applies.

## oh-my-pi (omp) - sibling adapter, shared shape (issues #18, #109)

`adapters/omp/` is its own package alongside `adapters/pi/` (split in #109); the two share
behavior through `@echo/shared`, not through one directory serving both hosts. The host
package import is type-only (erased at load), the lifecycle event surface is shape-identical,
and omp subagents hard-code `hasUI: false`, so suppression holds. The two host differences
the adapter absorbs:

- **`before_agent_start.systemPrompt` shape:** upstream Pi passes a `string`; omp passes a
  `string[]`. The injection handler feature-detects both and returns the same shape it
  received (`string[]` in → `[...base, instruction]` out). Unknown shapes still no-op safely.
- **Registration:** omp has no `pi install`. `bash scripts/install.sh --adapter omp` runs
  `adapters/omp/reconcile.ts`, which maintains a single `echo-voice` symlink in
  `~/.omp/agent/extensions/` pointing at the dedicated `adapters/omp/` (omp loads the entries
  declared in the package.json `pi` field through it). It **migrates** an existing Echo
  `echo-voice` link off the pre-split shared `adapters/pi/` onto `adapters/omp/` (#109). The script follows the reconcile-and-prune
  contract from #77 with strict ownership: Echo owns **only** the `echo-voice` name - no
  other entry is ever touched, whatever its target. The `echo-voice` entry is healed only
  when it provably belongs to Echo (a dead `*/adapters/pi` target from a renamed clone, or
  a live target whose package.json is `@echo/pi-adapter` - another Echo checkout, re-pointed
  at this one). Anything else occupying the name is FATAL (exit 2), never replaced.
  Reruns are idempotent; `--check` exits 0 when current / 3 when changes are pending /
  2 on a FATAL state, and the installer preflights `--check` (tolerating 3) so a FATAL
  state aborts before any host state is mutated.

omp reads the same canonical `ECHO_VOICE_*` configuration as Pi and defaults to the same
`voice_id: "pi"`, but speaks as `personaName: "omp"`. Local values from
`~/.config/echo/config.json` override those defaults for both hosts.
