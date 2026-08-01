# Configuration

Echo's persistent configuration is JSON at:

    ~/.config/echo/config.json

The complete machine-readable schema is shared/config-schema.json. The file uses canonical
Echo key names as JSON properties so the daemon, adapters, clone-independent payload, and
shell CLI share one unambiguous format:

    {
      "PORT": 3246,
      "ECHO_VOICE_PERSONA_NAME": "Echo",
      "ECHO_VOICE_ID": "echo",
      "ECHO_VOICE_ENABLED": true,
      "ECHO_VOICE_GREET_ON_START": true,
      "ECHO_EDGETTS_TIMEOUT_MS": 15000,
      "ECHO_TTS_CACHE_MAX_BYTES": 20000000,
      "ECHO_AUDIO_LIFECYCLE_LOG": "~/Library/Logs/echo/audio-lifecycle.jsonl"
    }

JSON was chosen because Echo already treats core/voices.json and its JSON schema as
authoritative configuration, and because typed booleans and numbers avoid dotenv's
string-only ambiguity. Paths beginning with ~ are passed through to the existing path
handling; use an absolute path when a tool does not expand it.

The file is optional. Missing or invalid files leave the documented defaults in effect, and
Echo logs a warning rather than failing startup. It is read from your home directory, never
from the daemon payload, so a plain reload picks up an edit, with no re-staging:

    launchctl kickstart -k "gui/$UID/com.echo"
    # or: bash scripts/restart.sh

(A `core/voices.json` edit is the case that also needs `cli/echo update`; see
[`operations.md`](operations.md#which-config-changes-need-a-re-stage).)

## Precedence and secrets

For a canonical setting, resolution is:

1. The matching property in config.json.
2. A live process value, honored for one release with a deprecation warning.
3. A matching value in a legacy dotenv file, also a one-release migration fallback.

Persistent configuration always wins. Move every non-secret Echo setting into config.json;
third-party secrets are the only supported environment configuration. Resolution remains
read-only: Echo never copies file values into process.env, preserving the import-purity
boundary between daemon and same-process adapter code.

**PORT is the one exception to layer 3.** It is read from config.json first and a deprecated
live PORT second, never from a dotenv file. `cli/echo`, the lifecycle scripts, and health
probes use the same order in pure bash (`scripts/echo-port.sh`). `scripts/install.sh` migrates
an existing dotenv PORT into config.json before it probes anything, so an upgrading user
keeps the configured port.

### ELEVENLABS_API_KEY: the one secret, and where it lives

ELEVENLABS_API_KEY is the only Echo secret, and config.json **rejects** it - a config.json
containing it has that one key dropped (see [Invalid keys](#invalid-keys)).

Its permanent home is a dotenv file, normally `~/.config/echo/.env`:

    mkdir -p ~/.config/echo
    echo 'ELEVENLABS_API_KEY=sk_…' >> ~/.config/echo/.env

That is not a migration leftover - it is the supported mechanism. The installed LaunchAgent
deliberately writes only HOME and PATH into `EnvironmentVariables` (`scripts/install.sh`
`write_plist`), so the daemon gets nothing from a login shell; a dotenv file is how the key
reaches it. **Do not delete `~/.config/echo/.env` after migrating** - migration moves the
non-secret settings out of it and leaves the file, and the key, alone. The only alternative
is a real process environment value, which means launching the daemon yourself instead of
through the LaunchAgent.

The core/voices.json value "\${ELEVENLABS_API_KEY}" is only an indirection to that value.
Do not commit .env files or put API keys in config.json.

### Invalid keys

A key that fails validation (an unknown name, a typo, a compound value, or the secret above)
is **dropped on its own**; every other setting in the file still applies. The daemon logs
one warning naming each dropped key, and reports the same thing in `GET /health`:

    curl -fsS http://localhost:3246/health | jq '.config'
    {
      "path": "/Users/you/.config/echo/config.json",
      "present": true,
      "valid": false,
      "ignored_keys": ["ECHO_VOICE_PERSONNA_NAME"],
      "errors": ["ECHO_VOICE_PERSONNA_NAME is not an Echo configuration key"]
    }

A file that is not valid JSON, or not a JSON object, cannot be partially applied: the whole
file is skipped, `valid` reads false, and the built-in defaults are used.

PAI_DIR, PAI_SETTINGS_PATH, PI_SETTINGS_PATH, PI_CODING_AGENT_DIR, OMP_EXTENSIONS_DIR,
ECHO_MCP_CONFIG_PATH, and CLAUDE_PROJECT_DIR remain host-owned runtime context or registration
path selectors. They describe a host, not Echo behavior, so they are not copied into this file.
ECHO_ENV_PATHS and ECHO_CONFIG_FILE are internal migration/test path selectors rather than
supported settings: the first prepends extra legacy dotenv locations, and the second retargets
config.json so an isolated test or development instance can redirect both reader and writer.
ECHO_CONVERSE_MAIN is likewise test/development subprocess injection. Test-only ECHO_E2E_PORT,
ECHO_E2E_CONVERSE_PORT, ECHO_SKIP_WORKSPACE_LINK, TEST_QUESTION, and TRANSCRIPT remain harness
plumbing. HOME, PATH, XDG_CACHE_HOME, XDG_STATE_HOME, terminal identity variables, and host
session variables remain standard process context. None of these exceptions configures Echo's
user-facing behavior.

## Schema reference

All properties are optional. Numeric values accept JSON numbers or strings and are bounded
at runtime; invalid values use the defaults below.

| Group | Properties | Defaults / notes |
| --- | --- | --- |
| Server | PORT, VOICES_PATH, PRONUNCIATIONS_PATH, ECHO_SAY_BIN | 3246; the two JSON files next to core/server.ts; /usr/bin/say |
| Developer tools | ECHO_PYTHON3_PATH | Python interpreter used by scripts/preview-voices.ts; /opt/homebrew/bin/python3 |
| Identity | ECHO_VOICE_PERSONA_NAME, ECHO_VOICE_ID, ECHO_VOICE_TITLE, ECHO_VOICE_CATCHPHRASE | Adapter defaults apply when unset |
| Voice policy | ECHO_VOICE_ENABLED, ECHO_VOICE_GREET_ON_START, ECHO_VOICE_SPEAK_COMPLETIONS, ECHO_VOICE_SUPPRESS, ECHO_VOICE_SUPPRESS_SUBAGENTS, ECHO_DEFAULT_TITLE | Booleans default to enabled/unsuppressed; title defaults to Voice Notification |
| Edge TTS | ECHO_EDGETTS_TIMEOUT_MS, ECHO_EDGETTS_TIMEOUT_MAX_MS, ECHO_EDGETTS_TIMEOUT_PER_CHAR_MS, ECHO_EDGETTS_HEALTH_TIMEOUT_MS, ECHO_EDGETTS_SYNTH_RETRIES, ECHO_EDGETTS_SYNTH_BACKOFF_MS, ECHO_CIRCUIT_BREAKER_THRESHOLD | 15000, 60000, 20, 3000, 1, 250, 2; floors are in reliability.md |
| Queue | ECHO_PLAY_QUEUE_MAX_DEPTH, ECHO_PLAY_QUEUE_AGE_CAP_MS, ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS, ECHO_AUDIO_PROCESS_TIMEOUT_MS, ECHO_NOTIFICATION_PROCESS_TIMEOUT_MS | 20, 300000, 120000, 60000, 10000 |
| Cache | ECHO_TTS_CACHE_DIR, ECHO_TTS_CACHE_MAX_BYTES, ECHO_TTS_CACHE_MAX_TEXT_CHARS, ECHO_AUDIO_CACHE_DIR | User-owned Echo cache directories; 20 MB and 80 characters for TTS cache limits |
| State and logs | ECHO_MUTE_STATE_PATH, ECHO_CAPTURE_STATE_PATH, ECHO_AUDIO_LIFECYCLE_LOG, ECHO_AUDIO_LIFECYCLE_LOG_MAX_BYTES, ECHO_RESOLUTION_LOG, ECHO_RESOLUTION_LOG_MAX_BYTES, ECHO_VOICE_EVENTS_LOG | Existing platform-specific paths; log caps default to 1 MB |
| Adapter endpoint | ECHO_DAEMON_URL, ECHO_NOTIFY_URL | Adapter-side endpoint settings; otherwise adapters use <http://localhost:3246> |
| Reserved | ECHO_VOICE_SURFACES | Schema-reserved; current runtime code does not read it |
| Voice ask (coordinator) | ECHO_CONVERSE_PORT, ECHO_CONVERSE_URL, ECHO_CONVERSE_BOOKING_LOCK, ECHO_CONVERSE_LEASE_MS, ECHO_CONVERSE_LOG_PATH | 32468 (keypad ECHOV; core keeps 3246), <http://localhost:32468>, ~/.local/state/echo/converse/booking.lock, capture + transcription budget plus slack (120000 at the shipped defaults), ~/Library/Logs/echo-converse.log |
| Voice ask (capture, read in the calling host) | ECHO_CONVERSE_CAPTURE_DIR, ECHO_CONVERSE_MAX_CAPTURE_MS, ECHO_CONVERSE_SILENCE_MS, ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS, ECHO_CONVERSE_LOCALE, ECHO_CONVERSE_STT_TIER, ECHO_CONVERSE_REC_BIN, ECHO_CONVERSE_SOX_BIN, ECHO_CONVERSE_YAP_BIN, ECHO_CONVERSE_WHISPER_BIN, ECHO_CONVERSE_WHISPER_MODEL | ~/Library/Caches/echo/converse, 30000, 1500, 60000, en-US, auto (yap then whisper), binaries resolved on PATH, no default model |

Settings whose behavior is not obvious from the name:

- **ECHO_SAY_BIN** points the macOS `say` fallback provider at a different executable. It is
  the last rung of the provider chain, so this is the knob for wrapping it (a logging shim, a
  routed audio device, or a no-op for a run that must stay silent). Unset means `/usr/bin/say`.

- **ECHO_CONVERSE_STT_TIER** pins the transcriber to `yap` or `whisper`. When it is set, a
  missing binary reports itself rather than falling through to the other rung, so nobody is
  transcribed through a tier they did not choose. `whisper` also needs
  **ECHO_CONVERSE_WHISPER_MODEL**, since whisper.cpp ships no model. Full pipeline and the v1
  limits: [converse.md](converse.md).

- **ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS** caps the transcription step the way
  ECHO_CONVERSE_MAX_CAPTURE_MS caps the recorder. A turn holds the capture state until it
  finishes and core skips every voice line while that state is non-idle, so an unbounded
  transcriber would mute Echo silently. Raise it only if a large whisper model on a slow
  machine genuinely needs longer; the turn's lease is derived from it.

- **PORT** must be canonical decimal, from 1 to 65535 - `3246` or `"3246"`. Digits only: no
  sign, no leading zero, no whitespace inside the quotes. Anything else is dropped as an
  invalid key (see [Invalid keys](#invalid-keys)) and Echo uses 3246. That covers other
  numeric spellings (`"0x0C9E"`, `"1e4"`, `"03246"`) and padded ones (`" 3246 "`), because
  the daemon and the pure-bash CLI resolve those to different ports, which would leave the
  daemon listening somewhere every CLI surface reports as down. `0` means an ephemeral bind,
  which no CLI can address, so only the test harness injects it as a live process value.
  Installing normalizes a padded dotenv PORT; any other spelling the grammar rejects
  is reported by name and left unmigrated rather than written and then dropped at startup.
- **ECHO_CAPTURE_STATE_PATH** points at the capture tool's published cross-process state file
  (default `~/.local/state/voicelayer/recording-state.json`; that tool hardcodes
  `~/.local/state` and consults no XDG variable). While it reports `recording`/`transcribing`
  from a live pid, voice lines are skipped at speak time (`held-for-capture` disposition;
  the banner is unaffected). A missing or corrupt file reads as idle, and an **empty string
  disables the guard entirely**.
- **ECHO_DAEMON_URL** is adapter-side and sets `POST /notify`, `POST /notify/personality` and
  `GET /voices` at once - and wins over `ECHO_NOTIFY_URL` for all of them - so pointing a host
  at a second instance can never split notify from the read endpoints
  (`shared/daemon-endpoints.ts`).
- **ECHO_PLAY_QUEUE_AGE_CAP_MS** sits comfortably above one line's worst-case occupancy
  (synth retries plus playback can approach ~2 min), so an ordinary slow line cannot
  mass-drop the backlog. Floors for every reliability knob:
  [`reliability.md`](reliability.md).

Voice provider mappings remain in core/voices.json, and pronunciation rules remain in
core/pronunciations.json. The configuration file controls the daemon and host-neutral
tuning around those files; it does not duplicate their provider schema. Their own reference
(the key tables, provider blocks, the ElevenLabs apiKey caveat, and the parse-error
fallback) lives in [`voices.md`](voices.md#reference-corevoicesjson).

## Migrating from ~/.config/echo/.env

An upgrade does not silently discard existing settings. For one release Echo still reads the
old dotenv locations as the lowest-priority layer and warns for every non-secret key it finds:

    paths in ECHO_ENV_PATHS (read, but never migrated; see below)
    ~/.config/echo/.env
    ~/.config/voicesystem/.env
    ~/.env

**The installer migrates for you.** `scripts/install.sh` (and `cli/echo install` /
`cli/echo update`) runs `scripts/migrate-config.ts` before anything else, which copies every
canonical Echo setting out of `~/.config/echo/.env` and `~/.config/voicesystem/.env` into
config.json and prints exactly which keys it moved. It is:

- **Non-destructive.** A key already in config.json is never overwritten, and the dotenv file
  is never edited or deleted. A `.bak` of the previous config.json is written on every change.
- **Idempotent.** A second run finds nothing to move and prints nothing.
- **Narrow.** Only canonical schema keys move. `ELEVENLABS_API_KEY` stays put (and the report
  says so), the retired aliases below are ignored, and host-owned variables are left alone.
- **Limited to Echo's own dotenv locations.** `~/.env` and `ECHO_ENV_PATHS` are never drained:
  `~/.env` is a shared user dotfile, not Echo's to rewrite. Move every non-secret Echo key there
  into config.json before the one-release fallback is removed. PORT is not read from those files.

After migration, delete migrated non-secret lines from `~/.config/echo/.env`, but keep the file
whenever it holds `ELEVENLABS_API_KEY`.

### Deprecated environment configuration

Every canonical Echo key in the schema is now a config.json property, not a supported
environment setting. A process or dotenv value remains a one-release compatibility fallback,
logs a warning naming the keys, and never overrides config.json. `ATLAS_VOICE_*` process values
share that warning path and fall back only when the canonical config property is unset.
`VOICESYSTEM_*` is already retired and ignored rather than migrated. The preview tool's
legacy `PYTHON3_PATH` follows the same one-release warning fallback and maps to
`ECHO_PYTHON3_PATH` in config.json.

`ATLAS_VOICE_*` to canonical:

| Old name | New canonical |
| --- | --- |
| `ATLAS_VOICE_NOTIFY_URL` | `ECHO_NOTIFY_URL` |
| `ATLAS_VOICE_ID` | `ECHO_VOICE_ID` |
| `ATLAS_VOICE_TITLE` | `ECHO_VOICE_TITLE` |
| `ATLAS_VOICE_CATCHPHRASE` | `ECHO_VOICE_CATCHPHRASE` |
| `ATLAS_VOICE_PERSONA_NAME` | `ECHO_VOICE_PERSONA_NAME` |
| `ATLAS_VOICE_ENABLED` | `ECHO_VOICE_ENABLED` |
| `ATLAS_VOICE_GREET_ON_START` | `ECHO_VOICE_GREET_ON_START` |
| `ATLAS_VOICE_SPEAK_COMPLETIONS` | `ECHO_VOICE_SPEAK_COMPLETIONS` |
| `ATLAS_VOICE_SUPPRESS` | `ECHO_VOICE_SUPPRESS` |
| `ATLAS_VOICE_SUPPRESS_SUBAGENTS` | `ECHO_VOICE_SUPPRESS_SUBAGENTS` |

Every `VOICESYSTEM_*` name maps to the `ECHO_*` name with the prefix swapped
(`VOICESYSTEM_DEFAULT_TITLE` → `ECHO_DEFAULT_TITLE`, and so on), with two convergences:
`VOICESYSTEM_NOTIFY_URL` → `ECHO_NOTIFY_URL` and `VOICESYSTEM_VOICE_ID` → `ECHO_VOICE_ID`.

To find both families across your own config:

```bash
rg -l 'ATLAS_VOICE_|VOICESYSTEM_' ~/.zshrc ~/.bashrc ~/.config/echo/.env 2>/dev/null
```

Rewrite each match to its canonical name, put it in config.json, and restart the daemon
(`bash scripts/restart.sh`).

> Filesystem default paths also moved (`…/atlas-voicesystem/…` → `…/echo/…`) and the
> LaunchAgent label changed (`com.atlas.voicesystem` → `com.echo`). A reinstall
> (`bash scripts/install.sh`) migrates the running service automatically - see the
> [CHANGELOG](../CHANGELOG.md).

## Port and CLI

The default daemon port is 3246 (E=3, C=2, H=4, O=6 on a phone keypad). The daemon,
cli/echo, lifecycle scripts, adapters, smoke checks, and docs all use that default. Put a
persistent override in config.json. Test harnesses may inject PORT for isolated instances;
that compatibility path warns and cannot override config.json.

The daemon and shell surfaces read config.json first, then the deprecated test/process fallback,
with the same bounds. That keeps `cli/echo doctor`, `status`, `mute`, and the installer's health
probe talking to the port the daemon actually bound. A rejected value falls back to 3246.

    curl -fsS http://localhost:3246/health
    curl -fsS -X POST http://localhost:3246/notify \
      -H 'Content-Type: application/json' \
      -d '{"message":"Echo online","voice_enabled":false}'
