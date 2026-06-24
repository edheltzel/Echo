# Security Model

atlas-voicesystem is a **local-only** TTS notification daemon. It is not a public service:
its threat model is "a process on this machine POSTs text to be spoken." This doc describes
the trust boundary, egress posture, and secret handling. For the request flow see
[`ARCHITECTURE.md`](ARCHITECTURE.md); for egress detail see
[`docs/providers-observability.md`](docs/providers-observability.md).

## Trust boundary

- **Localhost only.** The daemon binds `localhost:8888` (`PORT`, default 8888). It is meant
  to be reachable only by other processes on the same machine; do not expose it to a network.
- **CORS restricted to localhost.** `Access-Control-Allow-Origin` is hard-set to
  `http://localhost` (`core/server.ts`); `OPTIONS` returns `204`. Browsers on other origins
  cannot read responses.
- **Rate limiting.** `checkRateLimit` allows 10 requests per 60s per client IP (`429` on
  breach). Without a proxy header, all local callers share one `localhost` bucket — this is a
  flood guard against runaway loops, not an authentication mechanism.
- **Input sanitization.** Every spoken message passes `validateInput` (non-empty string, ≤500
  chars) and `sanitizeForSpeech`, which strips `<script`, `../`, shell metacharacters
  (`; & | > < \` $ \`), and markdown before the text reaches a provider or the macOS banner.

There is **no authentication** on `/notify` — any local process may request speech. That is
an accepted design property for a single-user local daemon, not an oversight; do not add
network exposure without revisiting it.

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
  runtime (`resolveEnvVar`, falling back to `process.env.ELEVENLABS_API_KEY`). The key is
  read once in the provider constructor — `/health` reports only `apiKeyConfigured: true|false`,
  never the key itself.
- **Env files load from user-owned paths** (`VOICESYSTEM_ENV_PATHS`,
  `~/.config/atlas-voicesystem/.env`, …), first-found-wins, never overriding an
  already-set `process.env` value.

## User-owned paths — never `/tmp`

Process state must live under user-owned cache/log/config paths, never `/tmp`:

- **Audio temp files:** `AUDIO_CACHE_DIR` (default `~/Library/Caches/atlas-voicesystem/audio`
  on macOS, else `$XDG_CACHE_HOME`/`~/.cache`), created with `mkdirSync(..., { mode: 0o700 })`
  and per-render `mkdtempSync` subdirectories.
- **Logs:** `~/Library/Logs/atlas-voicesystem.log` (human) and the separate
  `~/Library/Logs/atlas-voicesystem/voice-resolution.jsonl` (drop-off log), or `$XDG_STATE_HOME`/
  `~/.local/state` off macOS.

This is an invariant (see [`AGENTS.md`](AGENTS.md)): **do not write process state to `/tmp`.**

## Reporting

This is a personal/local tool. If you find a security issue, open a GitHub issue (or contact
the maintainer) — do not include live secrets in the report.
