# atlas-voicesystem

Standalone, multi-provider TTS notification server for coding agents, terminals, and scripts.

The server core accepts JSON on `localhost:8888` and speaks through a provider chain (`edge-tts → ElevenLabs → Kokoro → macOS say`). Host-specific lifecycle behavior now lives in adapters:

- `adapters/pai/` — PAI/Claude hook integration.
- `adapters/pi/` — Pi extension package integration.
- direct HTTP — any process can POST to `/notify`.

## Architecture

```mermaid
flowchart LR
  PAI[PAI adapter] --> Notify[/POST /notify/]
  Pi[Pi adapter] --> Notify
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

## Install

For humans: `docs/install-human.md`.

For autonomous agents: `docs/install-agent.md`.

Quick core-only install:

```bash
bash scripts/install.sh --adapter none
```

Install with PAI hooks:

```bash
bash scripts/install.sh --adapter pai
```

Install with Pi adapter:

```bash
bash scripts/install.sh --adapter pi
```

## Operation

```bash
bash scripts/status.sh
bash scripts/restart.sh
bash scripts/stop.sh
bash scripts/start.sh
```

Manual health check:

```bash
curl -fsS http://localhost:8888/health
```

Manual speak request:

```bash
curl -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from atlas voicesystem"}'
```

Silent smoke request:

```bash
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'
```

## API

### `POST /notify`

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
  "session_id": "optional-host-session-id",
  "source": "optional-host-name"
}
```

All fields are optional except `message`. `voice_enabled: false` keeps the notification path silent for smoke tests.

### `POST /notify/personality`

Compatibility endpoint for callers that only provide a `message`.

### `GET /health`

Returns provider status, fallback order, circuit-breaker state, pronunciation rule count, and emotional preset count.

## Voices

Voices are configured per agent in `core/voices.json`. The `identity` mapping is the default ("Atlas") voice; named agents — `kai`, `researcher`, `engineer`, `architect`, `designer`, `writer`, `qa-tester` — each carry their own voice. Select one by sending `"voice_id": "<agent>"`; agents without a mapping for the active provider fall back to that provider's default voice.

For the default `edge-tts` provider, each agent maps to a Microsoft neural voice with an optional `speed` (a multiplier converted to edge-tts's `--rate`, e.g. `1.08 → +8%`, `0.94 → -6%`). A `speed` of `1.0` (or no `edgetts` block) uses the global `providers.edgetts.rate`.

```json
"engineer": {
  "edgetts": { "voice": "en-GB-ThomasNeural", "speed": 0.94 }
}
```

### Auditioning edge voices

`scripts/preview-voices.ts` plays short samples so you can choose voices by ear before editing `voices.json`. It calls `edge-tts` directly and is dev tooling — not part of the runtime request path.

```bash
bun scripts/preview-voices.ts --list                                # list English voices, no audio
bun scripts/preview-voices.ts --locale en-GB                        # audition all en-GB voices
bun scripts/preview-voices.ts --voices en-GB-RyanNeural,en-GB-ThomasNeural
bun scripts/preview-voices.ts --voices en-GB-ThomasNeural --rate -6%
bun scripts/preview-voices.ts --dry-run --voices en-GB-RyanNeural   # print synth command, no audio
```

| Flag | Purpose | Default |
|---|---|---|
| `--locale` | Comma-separated locale prefixes to audition | `en-US,en-GB,en-AU,en-IE` |
| `--voices` | Explicit voice ids (overrides `--locale`) | — |
| `--text` | Sample line spoken (`{voice}` is substituted) | `Hi, I'm {voice}. This is how I sound for Atlas.` |
| `--rate` | edge-tts rate applied to every sample | `+0%` |
| `--list` / `--dry-run` | Print matched voices (and synth command) without playing audio | off |

## Development

See `docs/development.md`.

```bash
bun test
PORT=8889 tests/smoke-core.sh
```

## Dependency graph

See `docs/dependencies.md` for required runtime dependencies, optional TTS providers, and optional host adapters.

## PAI migration notes

See `MIGRATIONS.md`. Existing deep-path files under `claudecode/.claude/PAI/USER/Voice/` are compatibility wrappers or legacy config surfaces while installs migrate to `core/` + `adapters/`.

## Contributing

See `CONTRIBUTING.md`, especially the "Adding a Host Adapter" section.
