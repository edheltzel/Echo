# Security Model

Echo is a **local-only** TTS notification daemon. It is not a public service:
its threat model is "a process on this machine POSTs text to be spoken" plus, for the
optional voice ask, "a process on this machine asks the human a question and reads the
answer." This doc describes the trust boundary, egress posture, and secret handling. For the
request flow see [`ARCHITECTURE.md`](ARCHITECTURE.md); for egress detail see
[`docs/providers-observability.md`](docs/providers-observability.md).

## Trust boundary

- **Localhost only.** The daemon binds `localhost:3246` (`PORT`, default 3246). It is meant
  to be reachable only by other processes on the same machine; do not expose it to a network.
- **CORS restricted to localhost.** `Access-Control-Allow-Origin` is hard-set to
  `http://localhost` (`core/server.ts`); `OPTIONS` returns `204`. Browsers on other origins
  cannot read responses.
- **Rate limiting.** `checkRateLimit` allows 10 requests per 60s per client IP (`429` on
  breach). Without a proxy header, all local callers share one `localhost` bucket, apart from
  the control/read carve-outs listed in [`docs/http-api.md`](docs/http-api.md) - this is a
  flood guard against runaway loops, not an authentication mechanism.
- **Input sanitization.** Every spoken message passes `validateInput` (non-empty string, ≤500
  chars) and `sanitizeForSpeech`, which strips `<script`, `../`, shell metacharacters
  (`; & | > < \` $ \`), and markdown before the text reaches a provider or the macOS banner.
- **Native terminal visual delivery is adapter-owned, not core.** An adapter that routes a
  notification's title/body through Herdr or a supported terminal's OSC sequence
  (`shared/terminal-notify.ts`) normalizes that text independently of `sanitizeForSpeech` -
  stripping control/escape bytes and bounding length - and never writes to a hook's or the
  daemon's stdout. Alacritty and unproven tmux passthrough are treated as unsupported
  (fail-closed); the daemon only learns about a successful native delivery after the fact,
  via the exact `visual_delivery: "native"` marker (see [`docs/http-api.md`](docs/http-api.md)).

There is **no authentication** on `/notify` - any local process may request speech - and
the same applies to `/mute` (#83): any local process may flip the global mute. `GET /voices`
is likewise unauthenticated: any local process can read the configured persona keys and the
default provider name (no API keys or voice ids). Note the
reach is wider than "local process": a `POST` with an empty or `text/plain` body is a
CORS **simple request**, sent without preflight, so a cross-origin web page in a local
browser can fire it blind (e.g. `sendBeacon`) - the localhost CORS header only prevents
reading the *response*, not sending the request. That reach is an accepted risk for a
single-user local daemon (impact is audio-only; notifications are still processed and
logged), not an oversight; do not add network exposure without revisiting it.

## Voice ask (`echo-converse`)

The optional voice-ask capability adds a microphone to the picture, so it gets its own
boundary notes. Mechanism and process topology: [`docs/converse.md`](docs/converse.md).

- **A second unauthenticated localhost surface.** The coordinator binds `127.0.0.1:32468`
  (`ECHO_CONVERSE_PORT`) and, like `/notify`, authenticates nobody: any local process can book
  the microphone and cause a recording. Same accepted single-user risk, one rung higher, so do
  not expose it to a network either.
- **macOS TCC is the real gate.** The measured direct-terminal topology attributes capture to
  the terminal application, and the caller-side code normally spawns capture from the host
  adapter process rather than Echo's coordinator. Source-level checks keep capture code out of
  the coordinator; they do not enforce runtime ancestry. Pi and omp use the measured shape, while
  Claude Code's stdio MCP ancestry remains unverified and is recorded on each turn rather than
  guaranteed. No TCC grant means no audio, and there is deliberately no LaunchAgent for capture.
- **Transcription is local-only.** No cloud rung and no API key exists for speech-to-text, so
  a spoken answer never leaves the host.
- **The audio and the words stay in the capturing process.** The private capture directory is
  `0700`; the recorder output and converted whisper input are forced to `0600` before use. Every
  artifact is deleted on success, cancellation, and failure. `POST /turn/:id/complete` reports a
  character count, never the transcript, so the coordinator never sees the text.

## Egress posture

- **Default egresses.** The default provider `edgetts` is Microsoft's **online** TTS service,
  so out of the box, spoken text leaves the host to Microsoft. "No external calls" is *not*
  the default state.
- **Disabled providers make zero calls.** Egress gating is structural:
  `speakWithFallback` skips a disabled provider before any `isHealthy()`/`speak()`, and
  `getProviderStatus` only probes enabled providers. A disabled provider reaches no network.
  Proven by `tests/core/egress-gating.test.ts`.
- **Auditable via `/health`.** Each provider reports `wouldEgress` and (when true)
  `egressTarget`, so the current egress surface is inspectable at a glance.
- **Fully-local recipe.** Disable `edgetts`/`elevenlabs` and run `kokoro` (local endpoint) or
  `say`; every enabled provider's `wouldEgress` then reads `false`/local.

## Secret handling

- **No secrets in the repo.** `.env` files are not committed; `*.log` and `/tmp/` are
  gitignored. Never commit an API key.
- **ElevenLabs key via env.** `voices.json` carries only the placeholder
  `'${ELEVENLABS_API_KEY}'`; the daemon interpolates the real key from the environment at
  runtime (`resolveEnvVar`, falling back to a bare `ELEVENLABS_API_KEY`). The key is
  read once in the provider constructor - `/health` reports only `apiKeyConfigured: true|false`,
  never the key itself.
- **Config resolves from user-owned paths** - `~/.config/echo/config.json` wins,
  followed for one release by deprecated process and legacy dotenv fallbacks.
  Resolution is read-only and never writes values into `process.env`, so a secret
  in either file is not hydrated into the environment that same-process modules
  and spawned helpers inherit. `config.json` **rejects** `ELEVENLABS_API_KEY`, which keeps the one
  secret in a dotenv file that is never staged into the daemon payload. Precedence
  detail: [`docs/configuration.md`](docs/configuration.md).

## User-owned paths - never `/tmp`

Process state must live under user-owned cache/log/config paths, never `/tmp`:

- **Audio temp files:** `AUDIO_CACHE_DIR` (default `~/Library/Caches/echo/audio`
  on macOS, else `$XDG_CACHE_HOME`/`~/.cache`), created with `mkdirSync(..., { mode: 0o700 })`
  and per-render `mkdtempSync` subdirectories.
- **Logs:** `~/Library/Logs/echo.log` (human) and the separate
  `~/Library/Logs/echo/voice-resolution.jsonl` (drop-off log), or `$XDG_STATE_HOME`/
  `~/.local/state` off macOS.

This is an invariant (see [`AGENTS.md`](AGENTS.md)): **do not write process state to `/tmp`.**

## Reporting

This is a personal/local tool. If you find a security issue, open a GitHub issue (or contact
the maintainer) - do not include live secrets in the report.
