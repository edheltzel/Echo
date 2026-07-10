![Echo — a voice for any agent](assets/banner.png)

# Echo

Standalone, multi-provider TTS notification server for coding agents, terminals, and scripts.

The server core accepts JSON on `localhost:8888` and speaks through a provider chain (`edge-tts → ElevenLabs → Kokoro → macOS say`). Host-specific lifecycle behavior now lives in adapters:

- `adapters/claudecode/` — Claude Code hook integration.
- `adapters/pi/` — Pi extension package integration; the same adapter also serves the
  oh-my-pi (omp) fork.
- direct HTTP — any process can POST to `/notify`.

## Architecture

```mermaid
flowchart LR
  ClaudeCode[Claude Code adapter] --> Notify[/POST /notify/]
  Pi[Pi / oh-my-pi adapter] --> Notify
  Curl[Scripts / curl] --> Notify

  subgraph Core[Universal core]
    Notify --> Providers[Provider chain]
    Health[/GET /health/]
    Config[voices.json + pronunciations.json]
    Providers --> Config
  end

  Providers --> Edge[edge-tts]
  Providers --> Eleven[ElevenLabs]
  Providers --> Kokoro[Kokoro]
  Providers --> Say[macOS say]
```

The universal core is in `core/`. It should not import host adapters or assume PAI, Pi, or any other harness.

## Quickstart

Requires macOS and [Bun](https://bun.sh/). New to Echo? Follow the guided tutorial
instead: **[docs/getting-started.md](docs/getting-started.md)**.

```bash
bash scripts/install.sh --adapter none
```

The installer output ends with:

```
OK echo is healthy on :8888
```

Send your first spoken notification:

```bash
curl -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from Echo"}'
```

You should hear "Hello from Echo" spoken aloud and see:

```json
{"status":"accepted","message":"Notification accepted","request_id":"..."}
```

Hear nothing, or an unexpected voice? See [If you hear nothing — or the wrong voice](docs/getting-started.md#if-you-hear-nothing--or-the-wrong-voice).

## Install

The quickstart above installs the core only. To also wire a host adapter:

```bash
bash scripts/install.sh --adapter claudecode   # Claude Code hooks
bash scripts/install.sh --adapter pi           # Pi extension
bash scripts/install.sh --adapter omp          # oh-my-pi extension
```

Full install guide for humans (adapters, moved repos, uninstall): [docs/install-human.md](docs/install-human.md).

Step-by-step checklist for autonomous agents: [docs/install-agent.md](docs/install-agent.md).

## Operation

```bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/start.sh
bash scripts/mute.sh status    # runtime mute: on [minutes] | off | toggle | status
```

Manual health check:

```bash
curl -fsS http://localhost:8888/health
```

Silent smoke request:

```bash
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'
```

Update-after-pull, repo moves, logs, and uninstall caveats: [docs/operations.md](docs/operations.md).

## API

Four endpoints. Full contract: [docs/http-api.md](docs/http-api.md).

### `POST /notify`

```json
{
  "message": "Task complete",
  "voice_id": "themis",
  "title": "Voice Notification",
  "voice_enabled": true
}
```

All fields are optional — a missing `message` defaults to `"Task completed"`.
`voice_enabled: false` keeps the notification path silent for smoke tests.

`voice_id` takes a persona **name key** from `voices.json` (e.g. `kai`, `themis`). Omit it
to get the default Atlas identity voice; an unrecognized value falls back to the active
provider's default. See **Voices** below for resolution order.

### `POST /notify/personality`

Compatibility endpoint for callers that only provide a `message`.

### `POST /mute`

Global runtime mute: audio off while notifications are still accepted, processed, and
logged. An empty body toggles (one-keystroke hotkey friendly);
`{"muted": true, "duration_minutes": 30}` sets a timed mute. Day-to-day usage via
`scripts/mute.sh`: [docs/operations.md](docs/operations.md); endpoint contract + hotkey
bindings: [docs/http-api.md](docs/http-api.md).

### `GET /health`

Returns provider status, fallback order, circuit-breaker state, pronunciation rule count,
and emotional preset count. Each provider entry includes an egress audit; note that the
default provider, `edge-tts`, is an **online** Microsoft service. Edge's health probe is
status-only: `/notify` still tries real Edge synthesis unless Edge is disabled or its
circuit breaker is open. Details: [docs/http-api.md](docs/http-api.md),
[docs/providers-observability.md](docs/providers-observability.md), and
[docs/reliability.md](docs/reliability.md).

### Voice-resolution drop-off log

To make it observable *why* a `/notify` used the voice it did, the daemon appends one
structured JSONL event per voice-enabled `/notify` to
`~/Library/Logs/echo/voice-resolution.jsonl` — separate from the human-readable daemon log
(`~/Library/Logs/echo.log`). Failed attempts include diagnostics such as `phase`, `reason`,
`elapsed_ms`, `timeout_ms`, `exit_code`, and `stderr`, so Edge failures distinguish health
status, synthesis, playback, and circuit-breaker paths. Fields, retention, and overrides:
[docs/providers-observability.md](docs/providers-observability.md).

## Voices

Voices are configured per agent in `core/voices.json`. The `identity` mapping is the
default ("Atlas") voice — it speaks whenever `voice_id` is omitted. Every entry under
`agents` is a named persona keyed by a short lowercase name (`engineer`, `architect`,
`themis`, `clauderesearcher`, …). Select one by sending `"voice_id": "<key>"`.

**Resolution order** (`getVoiceMapping` in `core/server.ts`): the `voice_id` is matched against (1) an `agents` **name key**, then (2) any agent's `elevenlabs.voice_id`, then (3) the `identity` voice; no match falls back to the active provider's default voice. So callers should send the **name key** (e.g. `"themis"`), not a raw provider voice id.

For the default `edge-tts` provider, each agent maps to a Microsoft neural voice with an optional `speed` (a multiplier converted to edge-tts's `--rate`, e.g. `1.08 → +8%`, `0.94 → -6%`). A `speed` of `1.0` (or no `edgetts` block) uses the global `providers.edgetts.rate`.

```json
"engineer": {
  "edgetts": { "voice": "en-GB-ThomasNeural", "speed": 0.94 }
}
```

Changing a persona's voice, adding a new persona, and the per-turn persona voice spoken
by the Claude Code Stop hook are covered in [docs/voices.md](docs/voices.md).

### Gotchas: wrong voice or silence

- Sending a raw ElevenLabs voice id instead of the `voices.json` name key won't resolve
  while ElevenLabs is disabled — it speaks in the active provider's **default voice**
  instead of the persona you meant.
- Unexpected macOS `say` usually means Edge is disabled, the Edge circuit is open, or real
  Edge synthesis failed. Check `attempts[]` in the resolution log; the diagnostic health
  probe alone no longer forces `say` fallback.
- Port `31337` causes silence — voice traffic is `:8888`.

### Auditioning edge voices

Choose voices by ear with `bun scripts/preview-voices.ts` before editing `core/voices.json`. Commands and the full flag table live in [docs/voices.md](docs/voices.md).

## Deprecated environment variables

Echo reads `ECHO_*` environment variables. The former names — `ATLAS_VOICE_*` (Pi adapter)
and `VOICESYSTEM_*` (core) — still work as deprecated silent fallbacks, so nothing breaks
on upgrade. The full old→new mapping table and migration steps live in
[docs/configuration.md](docs/configuration.md#deprecated-environment-variables).

## Documentation

| I want to… | Read |
|---|---|
| Hear my first notification (guided tutorial) | [docs/getting-started.md](docs/getting-started.md) |
| Install adapters, move the repo, uninstall | [docs/install-human.md](docs/install-human.md) |
| Start/stop/restart, mute, update after a pull, read logs | [docs/operations.md](docs/operations.md) |
| Look up env files, `PORT`, and `voices.json` schema | [docs/configuration.md](docs/configuration.md) |
| Install via an agent-runnable checklist | [docs/install-agent.md](docs/install-agent.md) |
| Look up the HTTP API | [docs/http-api.md](docs/http-api.md) |
| Change or add voices; per-turn persona voice | [docs/voices.md](docs/voices.md) |
| Understand provider egress + the resolution log | [docs/providers-observability.md](docs/providers-observability.md) |
| Tune reliability / the circuit breaker | [docs/reliability.md](docs/reliability.md) |
| See required and optional dependencies | [docs/dependencies.md](docs/dependencies.md) |
| Write or wire a host adapter | [docs/adapters.md](docs/adapters.md) |

## Development

See `docs/development.md`.

```bash
bun test
PORT=8889 tests/smoke-core.sh
```

## Contributing

See `CONTRIBUTING.md`, especially the "Adding a Host Adapter" section.
