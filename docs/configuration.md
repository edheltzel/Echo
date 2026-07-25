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
Echo logs a warning rather than failing startup. Restart the daemon after changing it:

    cli/echo update
    # or, for an installed LaunchAgent:
    launchctl kickstart -k "gui/$UID/com.echo"

## Precedence and secrets

For a canonical setting, resolution is:

1. A value already present in the live process environment (compatibility override).
2. The matching property in config.json.
3. A matching value in a legacy dotenv file, during migration only.

Resolution is read-only: Echo never copies file values into process.env. This preserves
the import-purity boundary that prevents a daemon import from leaking one user's persona
into same-process adapter code.

ELEVENLABS_API_KEY is the only Echo secret. It is never accepted by config.json; provide
it through the process environment or a secret manager/file used to launch the daemon. The
core/voices.json value "\${ELEVENLABS_API_KEY}" is only an indirection. Do not commit
.env files or put API keys in config.json.

PAI_DIR, PAI_SETTINGS_PATH, PI_SETTINGS_PATH, PI_CODING_AGENT_DIR, OMP_EXTENSIONS_DIR,
and CLAUDE_PROJECT_DIR remain host-owned runtime context. They describe where a host keeps
its own settings or project, so they are not Echo settings and are not copied into this file.

## Schema reference

All properties are optional. Numeric values accept JSON numbers or strings and are bounded
at runtime; invalid values use the defaults below.

| Group | Properties | Defaults / notes |
|---|---|---|
| Server | PORT, VOICES_PATH, PRONUNCIATIONS_PATH | 3246; the two JSON files next to core/server.ts |
| Identity | ECHO_VOICE_PERSONA_NAME, ECHO_VOICE_ID, ECHO_VOICE_TITLE, ECHO_VOICE_CATCHPHRASE | Adapter defaults apply when unset |
| Voice policy | ECHO_VOICE_ENABLED, ECHO_VOICE_GREET_ON_START, ECHO_VOICE_SPEAK_COMPLETIONS, ECHO_VOICE_SUPPRESS, ECHO_VOICE_SUPPRESS_SUBAGENTS, ECHO_DEFAULT_TITLE | Booleans default to enabled/unsuppressed; title defaults to Voice Notification |
| Edge TTS | ECHO_EDGETTS_TIMEOUT_MS, ECHO_EDGETTS_TIMEOUT_MAX_MS, ECHO_EDGETTS_TIMEOUT_PER_CHAR_MS, ECHO_EDGETTS_HEALTH_TIMEOUT_MS, ECHO_EDGETTS_SYNTH_RETRIES, ECHO_EDGETTS_SYNTH_BACKOFF_MS, ECHO_CIRCUIT_BREAKER_THRESHOLD | 15000, 60000, 20, 3000, 1, 250, 2; floors are in reliability.md |
| Queue | ECHO_PLAY_QUEUE_MAX_DEPTH, ECHO_PLAY_QUEUE_AGE_CAP_MS, ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS, ECHO_AUDIO_PROCESS_TIMEOUT_MS, ECHO_NOTIFICATION_PROCESS_TIMEOUT_MS | 20, 300000, 120000, 60000, 10000 |
| Cache | ECHO_TTS_CACHE_DIR, ECHO_TTS_CACHE_MAX_BYTES, ECHO_TTS_CACHE_MAX_TEXT_CHARS, ECHO_AUDIO_CACHE_DIR | User-owned Echo cache directories; 20 MB and 80 characters for TTS cache limits |
| State and logs | ECHO_MUTE_STATE_PATH, ECHO_CAPTURE_STATE_PATH, ECHO_AUDIO_LIFECYCLE_LOG, ECHO_AUDIO_LIFECYCLE_LOG_MAX_BYTES, ECHO_RESOLUTION_LOG, ECHO_RESOLUTION_LOG_MAX_BYTES, ECHO_VOICE_EVENTS_LOG | Existing platform-specific paths; log caps default to 1 MB |
| Adapter endpoint | ECHO_DAEMON_URL, ECHO_NOTIFY_URL, ECHO_VOICE_SURFACES | Adapter-side endpoint overrides; otherwise adapters use http://localhost:3246 |

Voice provider mappings remain in core/voices.json, and pronunciation rules remain in
core/pronunciations.json. The configuration file controls the daemon and host-neutral
tuning around those files; it does not duplicate their provider schema.

## Migrating from ~/.config/echo/.env

An upgrade does not silently discard existing settings. Echo reads the old dotenv locations
as the lowest-priority compatibility layer:

    paths in ECHO_ENV_PATHS (migration selector only)
    ~/.config/echo/.env
    ~/.config/voicesystem/.env
    ~/.env

Move each non-secret Echo setting into ~/.config/echo/config.json, move
ELEVENLABS_API_KEY to the daemon's secret environment/file mechanism, then restart Echo.
Keep the old file temporarily if desired; JSON wins over it, and a live process value wins
over both. Once the migration is confirmed, remove the old config entries and keep only the
secret outside JSON.

The former voice-system-prefixed aliases were retired in this release. Use the canonical property names
shown in the schema; an old alias in a dotenv file is ignored. The old
~/.config/voicesystem/.env location is still read only so its remaining canonical keys can
be migrated without a behavior change.

## Port and CLI

The default daemon port is 3246 (E=3, C=2, H=4, O=6 on a phone keypad). The daemon,
cli/echo, lifecycle scripts, adapters, smoke checks, and docs all use that default. An
explicit live PORT override remains useful for an isolated development daemon; the normal
installed LaunchAgent reads config.json.

    curl -fsS http://localhost:3246/health
    curl -fsS -X POST http://localhost:3246/notify \
      -H 'Content-Type: application/json' \
      -d '{"message":"Echo online","voice_enabled":false}'
