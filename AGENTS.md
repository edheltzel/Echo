# AGENTS.md

Current source of truth for agents working on `atlas-voicesystem`.

## Current architecture

The repo has migrated from a PAI-shaped stow tree to a universal core plus host adapters.

- Universal server core: `core/server.ts`, `core/voices.json`, `core/pronunciations.json`
- Shared HTTP client/types/schema: `core/notify-client.ts`, `core/types.ts`, `core/voices-schema.json`
- PAI adapter: `adapters/pai/`
- Pi adapter: `adapters/pi/`
- Neutral lifecycle scripts: `scripts/{install,start,stop,restart,status,uninstall}.sh`
- Historical PAI stow path: `claudecode/.claude/PAI/USER/Voice/` now contains compatibility entrypoints/wrappers and legacy config surfaces.

Do **not** add host-specific logic to `core/`. Host lifecycle behavior belongs in an adapter that calls `POST /notify`.

## Quick commands

```bash
# Core-only install
bash scripts/install.sh --adapter none

# Install with PAI hook registration
bash scripts/install.sh --adapter pai

# Install with Pi extension registration
bash scripts/install.sh --adapter pi

# Lifecycle
bash scripts/status.sh
bash scripts/start.sh
bash scripts/stop.sh
bash scripts/restart.sh
bash scripts/uninstall.sh

# Health / smoke
curl -fsS http://localhost:8888/health
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'
```

New service identity:

- LaunchAgent label: `com.atlas.voicesystem`
- Plist: `~/Library/LaunchAgents/com.atlas.voicesystem.plist`
- Log: `~/Library/Logs/atlas-voicesystem.log`

The installer unloads and quarantines the old `com.pai.voice-server` plist if found. Do not resurrect the old service from compatibility scripts.

## HTTP API

### `POST /notify`

Primary host-neutral endpoint. Body:

```json
{
  "title": "Voice Notification",
  "message": "Task complete",
  "voice_enabled": true,
  "voice_id": "kai",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.75,
    "style": 0.0,
    "speed": 1.0,
    "use_speaker_boost": true
  },
  "session_id": "host-session-id",
  "source": "pi"
}
```

Only `message` is required. Use `voice_enabled:false` for silent smoke tests.

### `POST /notify/personality`

Compatibility endpoint for callers that only provide a `message`.

### `GET /health`

Returns provider status, fallback order, circuit-breaker state, pronunciation rule count, and emotional preset count.

Each provider entry carries an **egress audit** (`getProviderStatus` in `core/server.ts`): `enabled`, `healthy`, and `wouldEgress` (true only when the provider is *both* enabled and makes an outbound network request when used), plus `egressTarget` when `wouldEgress` is true. This makes the gating guarantee auditable at a glance — a disabled provider always reports `wouldEgress: false` and omits `egressTarget`.

Unsupported POST paths now return explicit JSON `404`; the universal core does not expose a PAI-named route.

### Provider egress gating

A **disabled** provider makes **zero** outbound network calls — no synthesis request and no auth/health probe. The guarantee is structural, not best-effort:

- `speakWithFallback` (`core/server.ts`) checks `provider.isEnabled()` and `continue`s **before** ever calling `isHealthy()` or `speak()`, so a disabled provider's network paths are unreachable.
- `getProviderStatus` only runs `isHealthy()` `if (enabled)`, so the `/health` probe never reaches a disabled provider either.
- `ElevenLabsProvider.isEnabled()` requires `enabled:true` **and** an API key; `isHealthy()` makes no network call (the key is read in the constructor). With ElevenLabs disabled, nothing ever reaches `api.elevenlabs.io`.
- `KokoroProvider` is contacted **only when enabled** — `isHealthy()` short-circuits on `!isEnabled()` before probing its endpoint, and `speak()` is gated by the same `isEnabled()` check upstream.

Proven by `tests/core/egress-gating.test.ts` (spies `fetch`; asserts zero calls for a disabled provider across both `speakWithFallback` and `getProviderStatus`, and that enabling a provider is the only thing that flips egress on).

**edge-tts egresses by default.** The default provider (`edgetts`) is Microsoft's **online** TTS service, so "no external calls" is not the out-of-the-box state — edge-tts leaves the host to Microsoft (see #1). For a fully-local setup, run a local provider (`kokoro` against a local endpoint, or `say`) and disable `edgetts`/`elevenlabs`; `/health` `wouldEgress` flags then read `false`/local for every enabled provider.

## Voices

Per-persona voices live in `core/voices.json` under `agents`, keyed by a short lowercase name. `getVoiceMapping` (`core/server.ts`) resolves a request `voice_id` by: (1) `agents` name key, (2) any `elevenlabs.voice_id`, (3) `identity`, else the active provider's default. Callers send the **name key** (e.g. `"themis"`), not a raw provider voice id.

**Change a voice:** edit that agent's `edgetts.voice`/`speed`, then reload the daemon (`launchctl kickstart -k "gui/$UID/com.atlas.voicesystem"`). Audition first with `bun scripts/preview-voices.ts --list` / `--locale`.

**Add a voice/persona:** add a keyed entry (mirror an existing one; validate the voice name with `--list`), reload the daemon. Then bind the persona in its `atlas-config` brief (`~/.claude/agents/<Name>.md`): set frontmatter `voiceId: <key>` and make every self-voice `curl` POST `http://localhost:8888/notify` with `"voice_id":"<key>"`. The self-voice instruction must be in the brief **body** (frontmatter isn't visible to the agent). Full walkthrough: README → **Voices**.

`tests/core/voices-config.test.ts` iterates every `agents` entry, so new voices are validated by `bun test`.

### Per-turn persona voice (Stop hook)

Every turn, the PAI Stop hook `adapters/pai/hooks/VoiceCompletion.hook.ts` speaks the response's voice line. It is **persona-aware in both voice and words**: a single canonical parser `parseFinalVoiceLine` (`adapters/pai/hooks/lib/TranscriptParser.ts`) reads the response's trailing `🗣️ <Name>:` tag into `{name, words}`, and both the voice resolver and the words extractor consume it so the chosen voice and the spoken words can never disagree. `handleVoice` (`adapters/pai/hooks/handlers/VoiceNotification.ts`) calls `selectVoice`/`resolvePersonaKey` (which delegate to `parseFinalVoiceLine`) for the **voice**; `extractVoiceCompletion` (same parser) yields the **words**. When `<Name>` is a non-DA persona (e.g. `🗣️ Themis:`), the hook sends that lowercase **name key** as `voice_id` (daemon resolves `themis` → `en-US-MichelleNeural`) and speaks the persona's own line. When the speaker is the DA (Atlas) or there is no tag, both voice (`mainDAVoiceID` + prosody) and words are the unchanged Atlas path.

This is DRY and self-cleaning: the signal is the response the hook already parses (no marker files, env vars, or registries), so dropping a persona reverts to Atlas on the next turn automatically. For a **main-session** persona to be voiced, its turns must carry the `🗣️ <Persona>:` tag (the global response format already does this). `parseFinalVoiceLine`/`resolvePersonaKey`/`selectVoice` are covered by `tests/adapters/pai/voice-persona-resolution.test.ts`; `extractVoiceCompletion`'s persona-words behavior by `tests/adapters/pai/voice-completion-words.test.ts`.

The Stop hook is repo-owned and registered into `settings.json` by `restore-hooks.ts` (replacing any unmanaged `~/.claude/hooks/VoiceCompletion.hook.ts`), alongside VoiceGate and VoiceGreeting. Its transcript parsing lives in `adapters/pai/hooks/lib/{hook-io,TranscriptParser}.ts` (PAI-specific — never in `core/`).

## Development workflow

```bash
git checkout dev
bun test
PORT=8889 tests/smoke-core.sh
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/atlas-pi-adapter-build
```

After changing `core/server.ts`, restart the neutral service:

```bash
launchctl kickstart -k "gui/$UID/com.atlas.voicesystem"
tail -f ~/Library/Logs/atlas-voicesystem.log
```

Use Bun only. Do not introduce npm/npx/node-based workflows.

### Provider reliability (circuit breaker)

`core/circuit-breaker.ts` tracks **provider** (synthesis/network) failures per TTS provider and opens after a shared threshold, skipping the provider for a cooldown then half-opening to retest. Attribution rule: a **local playback** failure (afplay/mpv) is NOT a provider failure and must never call `recordProviderFailure` — `EdgeTTSProvider.speak` splits synthesis (governed by the breaker, retried) from playback (local, never opens the breaker). edge-tts is Microsoft's **online** WebSocket service, so transient blips are retried before a failure is recorded.

Tunable via env (all parsed through `core/env.ts` `parseBoundedInt`, which falls back to the default for missing/non-numeric/below-floor values):

| Env var | Default | Floor |
|---|---|---|
| `VOICESYSTEM_CIRCUIT_BREAKER_THRESHOLD` | 2 | 1 |
| `VOICESYSTEM_EDGETTS_TIMEOUT_MS` | 15000 | 1 |
| `VOICESYSTEM_EDGETTS_SYNTH_RETRIES` | 1 | 0 |
| `VOICESYSTEM_EDGETTS_SYNTH_BACKOFF_MS` | 250 | 1 |

The threshold is **global** across edgetts/elevenlabs/kokoro. Worst-case first-turn latency when edge-tts is down is ~30s (2 attempts × 15s + backoff) before fallback; mitigated because `speakWithFallback` is single-pass, so the same turn still falls through to local `say`.

## File guide

| Purpose | Path |
|---|---|
| Universal daemon | `core/server.ts` |
| Provider circuit breaker | `core/circuit-breaker.ts` |
| Numeric env parsing | `core/env.ts` |
| Voice config | `core/voices.json` |
| Pronunciation config | `core/pronunciations.json` |
| Shared notify client | `core/notify-client.ts` |
| PAI hooks | `adapters/pai/hooks/` |
| Per-turn voice (Stop hook) | `adapters/pai/hooks/VoiceCompletion.hook.ts` |
| Per-turn voice handler | `adapters/pai/hooks/handlers/VoiceNotification.ts` |
| Transcript parsing (PAI) | `adapters/pai/hooks/lib/{hook-io,TranscriptParser}.ts` |
| PAI hook registration | `adapters/pai/restore-hooks.ts` |
| Pi extension package | `adapters/pi/` |
| Neutral install/lifecycle | `scripts/` |
| Human install docs | `docs/install-human.md` |
| Agent install docs | `docs/install-agent.md` |
| Dev docs | `docs/development.md` |
| Migration notes | `MIGRATIONS.md` |

## Invariants / must not do

- Do not import PAI, Pi, Claude Code, OpenCode, or other host APIs from `core/`.
- Do not add new PAI-named endpoints to the universal server.
- Do not change the `/notify` request/response contract without an explicit compatibility plan.
- Do not write process state to `/tmp`; use user-owned cache/log/config paths.
- Do not add new `localhost:31337` references; voice server traffic is `:8888`.
- Do not broad-kill whatever owns port `8888`; it may be another service.
- Do not commit secrets or `.env` files.
- Do not push directly to `master`; work on `dev` and open PRs from `dev` to `master`.

## Adapter rules

Adapters are out-of-process host integrations. They should:

1. Observe host lifecycle events.
2. Extract a short user-facing message (for Pi/PAI, the final `🗣️` line).
3. Add `source` and `session_id` metadata when available.
4. POST to `http://localhost:8888/notify`.
5. Treat notify failures as non-fatal host-session warnings.
6. Suppress child/subagent contexts to avoid audio floods.

## PAI compatibility path

The old deep files under `claudecode/.claude/PAI/USER/Voice/` are compatibility wrappers:

- `server.ts` imports `core/server.ts` while preserving legacy PAI config/env paths.
- Hook entrypoints import/re-export `adapters/pai/hooks/...`.
- Lifecycle shell scripts delegate to root `scripts/` and old install defaults to `--adapter pai`.

## Validation before shipping

Run at minimum:

```bash
bun test
PORT=8889 tests/smoke-core.sh
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/atlas-pi-adapter-build
```

For PAI wrapper smoke checks:

```bash
printf '{"tool_name":"Bash","tool_input":{"command":"echo ok"}}' \
  | bun run claudecode/.claude/PAI/USER/Voice/hooks/VoiceGate.hook.ts

printf '{"source":"resume"}' \
  | bun run claudecode/.claude/PAI/USER/Voice/hooks/VoiceGreeting.hook.ts
```

## Agent skills

### Issue tracker

Hybrid: draft issues/PRDs locally under `.scratch/<feature>/`, promote to GitHub Issues (`gh`) as the canonical shared tracker. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

### Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

### Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

### Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

### Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

### Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

### Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

### Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

### User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md.

### Child DOX Index

This repository is single-context: the root `AGENTS.md` is the sole DOX contract — there are no child `AGENTS.md` files yet. Add one when a folder becomes a durable boundary that needs its own contract (likely candidates: `core/`, `adapters/pai/`, `adapters/pi/`, `scripts/`).
