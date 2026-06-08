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

Unsupported POST paths now return explicit JSON `404`; the universal core does not expose a PAI-named route.

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

## File guide

| Purpose | Path |
|---|---|
| Universal daemon | `core/server.ts` |
| Voice config | `core/voices.json` |
| Pronunciation config | `core/pronunciations.json` |
| Shared notify client | `core/notify-client.ts` |
| PAI hooks | `adapters/pai/hooks/` |
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
