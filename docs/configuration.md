# Configuration

Canonical reference for every place Echo reads configuration: environment files, environment
variables, `core/voices.json`, and `core/pronunciations.json`. For voice customization
how-tos (change a voice, add a persona, enable ElevenLabs) see [`voices.md`](voices.md); for
the request contract see [`http-api.md`](http-api.md).

**All configuration is read once, at daemon startup.** Edits to any env file, `voices.json`,
or `pronunciations.json` take effect only after a restart:

```bash
launchctl kickstart -k "gui/$UID/com.echo"
```

## Environment files

At startup the daemon loads `KEY=VALUE` lines from these files, in order (`core/server.ts`):

1. Every path in `ECHO_ENV_PATHS` (colon-separated; legacy `VOICESYSTEM_ENV_PATHS` honored as
   a silent fallback)
2. `~/.config/echo/.env` — the recommended home for secrets such as `ELEVENLABS_API_KEY`
3. `~/.config/voicesystem/.env` (legacy)
4. `~/.env`

Precedence rules:

- A key is set only if not already present, so the **first file found wins per key**, and a
  real environment variable (e.g. set in the LaunchAgent plist) always beats every file.
- Surrounding single or double quotes around values are stripped.
- Lines without `=`, keys starting with `#`, and empty values are ignored.
- No file is required to exist.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8888` | HTTP listen port |
| `VOICES_PATH` | `voices.json` next to `core/server.ts` | Voice config file location |
| `PRONUNCIATIONS_PATH` | `pronunciations.json` next to `core/server.ts` | Pronunciation rules location |
| `ELEVENLABS_API_KEY` | — | ElevenLabs API key (see indirection below) |
| `ECHO_DEFAULT_TITLE` | `Voice Notification` | Title when a `/notify` body omits `title` |
| `ECHO_AUDIO_CACHE_DIR` | `~/Library/Caches/echo/audio` (macOS), else `$XDG_CACHE_HOME`/`~/.cache` under `echo/audio` | Synthesis temp files |
| `ECHO_AUDIO_PROCESS_TIMEOUT_MS` | `60000` | Playback process (afplay/mpv/say) timeout |
| `ECHO_NOTIFICATION_PROCESS_TIMEOUT_MS` | `10000` | macOS notification (osascript) timeout |
| `ECHO_RESOLUTION_LOG` / `ECHO_RESOLUTION_LOG_MAX_BYTES` | see [`providers-observability.md`](providers-observability.md) | Voice-resolution drop-off log path / size cap |
| `ECHO_CIRCUIT_BREAKER_THRESHOLD`, `ECHO_EDGETTS_TIMEOUT_MS`, `ECHO_EDGETTS_SYNTH_RETRIES`, `ECHO_EDGETTS_SYNTH_BACKOFF_MS` | see [`reliability.md`](reliability.md) | Circuit breaker + edge-tts retry knobs |

Every `ECHO_*` knob also accepts its legacy `VOICESYSTEM_*` name as a deprecated silent
fallback (see the root README → "Deprecated environment variables").

## `core/voices.json`

Location: `core/voices.json`, or wherever `VOICES_PATH` points. Top-level keys:

| Key | Meaning |
|---|---|
| `providers` | Per-provider config blocks (below) |
| `defaultProvider` | Provider tried first (shipped: `edgetts`) |
| `fallbackOrder` | Full chain (shipped: `edgetts → elevenlabs → kokoro → say`) |
| `default_volume` | `0.8` — playback volume, applied unevenly (caveat below) |
| `default_rate` | `175` — words/min for the `say` provider only |
| `identity` | The default ("Atlas") voice mapping, used when `voice_id` is omitted |
| `agents` | Named persona mappings keyed by short lowercase name (`kai`, `themis`, …) |

### Provider order

Per notification, `speakWithFallback` walks `defaultProvider` first, then `fallbackOrder`
minus the duplicate — a single pass. A **disabled** provider is skipped before any network or
health path (the structural egress gate — [`providers-observability.md`](providers-observability.md));
an unhealthy or circuit-open provider is skipped ([`reliability.md`](reliability.md)); a
failed provider falls through to the next.

### Provider blocks

| Provider | Keys |
|---|---|
| `edgetts` | `enabled`, `defaultVoice` (`en-US-AvaNeural`), `rate` (global edge-tts rate, `"+0%"`) |
| `elevenlabs` | `enabled` (shipped `false`), `apiKey`, `defaultVoiceId` |
| `kokoro` | `enabled` (shipped `false`), `endpoint` (`http://127.0.0.1:8880/v1`), `defaultVoice` |
| `say` | `enabled`, `voice` (`Daniel (Enhanced)`) |

**ElevenLabs `apiKey` indirection:** the shipped value `"${ELEVENLABS_API_KEY}"` is expanded
from the environment at startup (`resolveEnvVar`); a bare `ELEVENLABS_API_KEY` env var is
also accepted as a constructor fallback. The provider is enabled only when
`enabled: true` **and** a key resolved. Caveat: `/health`'s `apiKeyConfigured` field reflects
only the config-file indirection, not the bare-env fallback — the provider can work while
`apiKeyConfigured` reads `false`.

### Identity and agent mappings

`identity` and each `agents.<key>` entry carry per-provider voice blocks: `edgetts.voice` +
optional `speed` (multiplier → edge-tts rate, `1.08 → +8%`; `1.0` or absent uses the global
`providers.edgetts.rate`), `elevenlabs.voice_id` + optional stability/similarity/style/
speaker-boost, `kokoro.voice` + optional `speed`. Resolution order and customization
walkthroughs: [`voices.md`](voices.md).

### `default_volume` / `default_rate` caveats

`default_volume` is applied via `afplay -v` to **ElevenLabs and Kokoro playback only**;
edge-tts playback spawns afplay without `-v`, so the default provider ignores it. `say` uses
`default_rate` (words/min) instead and ignores volume. An out-of-range `default_volume`
falls back to `1.0`.

### Parse-error fallback

A missing or malformed `voices.json` does not stop the daemon: it logs one
`⚠️ Failed to load voices.json` warning at startup and uses **built-in defaults that differ
from the shipped file** — kokoro `enabled: true` and an empty `agents` map, so every persona
`voice_id` then resolves as `fallback`. If all persona voices break at once, check the top of
`~/Library/Logs/echo.log` for that warning. When the file does parse, it is merged over the
defaults: top-level keys shallowly, `providers` one level deep — `identity`, `agents`, and
`fallbackOrder` are taken wholesale from your file.

## `core/pronunciations.json`

Location: `core/pronunciations.json`, or wherever `PRONUNCIATIONS_PATH` points. Shape:
`{"replacements": [{"term", "phonetic", "note"?}]}`. Each term is replaced whole-word before
synthesis by the edge-tts, ElevenLabs, and Kokoro providers (`say` does not apply them). The
loaded rule count is surfaced in `GET /health` as `pronunciation_rules`.
