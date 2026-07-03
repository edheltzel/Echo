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
4. POST to `http://localhost:8888/notify`.
5. Treat notify failures as non-fatal host-session warnings.
6. Suppress child/subagent contexts to avoid audio floods.

## Registration contract — reconcile and prune (issue #77)

Every adapter MUST ship an **idempotent reconcile-and-prune registration** for whatever host
config holds its repo paths. Append-only registration is forbidden: a repo directory rename
leaves the old path behind, and the failure is silent on hosts that skip a missing package
(Pi) and loud on hosts that execute the registered path (Claude Code). Both happened in
production on 2026-07-02.

A conforming registration:

1. **Sets the required path explicitly** — derives the canonical path from the adapter's own
   location (`import.meta.url`), never from a hardcoded clone location.
2. **Prunes stale variants** — removes or replaces in place any registration that matches the
   adapter's pattern but is not the canonical path (dead paths from a rename, duplicates from
   append-style installs).
3. **Is idempotent** — rerunning against an already-correct config is a byte-for-byte no-op.
4. **Supports `--check`** — reports pending changes (including stale paths) without mutating,
   exiting 0 when current and 3 when changes are pending (machine-checkable).
5. **Edits through symlinks** — if the host config may be a symlink (e.g. into a dotfiles
   repo), write by atomically replacing the resolved real file, never the symlink itself.

Existing implementations to copy: `adapters/claudecode/restore-hooks.ts` (hook entries in
`~/.claude/settings.json`) and `adapters/pi/reconcile.ts` (packages entry in
`~/.pi/agent/settings.json`). `scripts/install.sh` re-reconciles **every installed adapter on
every run** regardless of `--adapter`, and `scripts/install.sh --check` aggregates the
adapters' check modes plus the LaunchAgent plist paths — a new adapter must plug its
reconcile and check commands into both. Future hosts (oh-my-pi #18, Codex/OpenCode #30)
inherit this contract.

## Pi adapter — per-turn completions (issue #15)

Pi's own models don't emit the `🗣️` voice line on their own, so the Pi adapter **injects** the
convention. On `before_agent_start` (`adapters/pi/index.ts`) it appends an instruction to the
chained `event.systemPrompt` (feature-detected; falls back to `systemPromptAppend`; no-ops on
older runtimes) telling the model to end each response with `🗣️ <Name>: <8–16 word
summary>`. The existing `message_end`/`turn_end` path then extracts and speaks that line — so
Pi speaks per-turn completions like the Claude Code path, not just the startup greeting.

- **Persona name** comes from config: `personaName` ← env `ECHO_VOICE_PERSONA_NAME` (default
  `"Pi"`), never hard-coded.
- **Distinct voice (issue #76):** `voiceId` defaults to `"pi"` (env `ECHO_VOICE_ID` overrides),
  which the daemon resolves via `agents.pi` in `core/voices.json` → `en-US-GuyNeural`. Unlike
  the injection feature above, #76 also touched `core/voices.json` data — a running daemon
  loads voices.json once at startup, so restart it
  (`launchctl kickstart -k "gui/$UID/com.echo"`) to pick up the `pi` entry; until then the
  adapter's `voice_id: "pi"` is unresolvable and falls back to the provider default voice
  (audibly the identity voice on stock installs), logged as `resolution: fallback`.
- Injection is gated on `config.speakCompletions` (default on) **and** the same
  `shouldSuppressVoice` check the speak side uses (headless/subagent stays silent).
- `extractVoiceLineFromText` (`adapters/pi/voice-line.ts`) strips an optional leading
  `<Name>:` (mirroring the Claude Code adapter's `parseFinalVoiceLine` name grammar) so the persona name isn't
  spoken aloud.
- The injection feature itself (#15) is adapter-only: no `core/` or daemon change; the daemon
  already resolves `voice_id` name keys.

The full design rationale is catalogued in
[`design-docs/pi-completion-injection.md`](design-docs/pi-completion-injection.md).
