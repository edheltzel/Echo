# HTTP API

The universal core (`core/server.ts`) listens on `localhost:8888` (override: `PORT`) and
exposes five endpoints. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for where this sits
in the request flow, [`../SECURITY.md`](../SECURITY.md) for the trust boundary, and
[`configuration.md`](configuration.md) for the config the server reads at startup.

**Rate limit:** 10 requests per 60s per client, across all endpoints; exceeding it returns
`429 {"status":"error","message":"Rate limit exceeded"}`. All local callers share one
`localhost` bucket — except `POST /mute`, which gets its own bucket so a notification
flood can never starve the mute control (#83).

## `POST /notify`

Primary host-neutral endpoint. Body (every field optional):

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

| Field | Default | Notes |
|---|---|---|
| `title` | `Voice Notification` (`ECHO_DEFAULT_TITLE`) | macOS notification title |
| `message` | `"Task completed"` | The spoken/displayed text |
| `voice_enabled` | `true` | `false` = silent (notification only, no TTS, **no resolution-log event**) |
| `voice_id` | — (identity voice) | Short persona **name key** (e.g. `"themis"`), not a raw provider voice id — resolution order and traps in [`voices.md`](voices.md). `voice_name` is accepted as an alias; `voice_id` wins when both are present |
| `voice_settings` | — | Pass-through override, see below |
| `session_id`, `source` | — | Echoed into the daemon log for correlation |

Validation: `title` and `message` are each rejected with `400` when over **500 characters**,
then sanitized for speech — shell metacharacters (`` ;&|><`$\ ``) stripped, markdown
(bold/italic/inline code/headers) unwrapped, `<script` and `../` removed. A message that is
empty after sanitization is a `400`. Square-bracketed `[markers]` are stripped from the
spoken text.

**Emotional markers:** a `[<emoji> <name>]` marker anywhere in `message` (e.g. `[🎯 focused]`,
`[🚨 urgent]`) selects a preset that overrides `stability`/`similarity_boost` after voice
resolution. The emoji and name must agree with the server's preset table
(`EMOTIONAL_PRESETS` in `core/server.ts`; count surfaced in `/health`). Audible only on
ElevenLabs — edge-tts/kokoro consume just `speed`.

**`voice_settings` semantics:** any non-empty object switches settings to full
**pass-through** — it replaces the persona's stored settings entirely (missing fields are
filled from server defaults: stability 0.5, similarity 0.75, style 0.0, speed 1.0,
speaker-boost true), and the resolved persona mapping then contributes only the voice
name/id. `speed` is consumed by edge-tts/kokoro; the rest by ElevenLabs.

Response: `202 {"status":"accepted","message":"Notification queued","request_id":"req-…"}`.
Errors: `400 {"status":"error","message":"Invalid …","request_id":…}` for validation
failures (rejected **before** the line is queued), `500` otherwise.

**`202` on receipt (Phase 2 serialization).** `/notify` acks as soon as the request is
validated; the macOS **banner fires immediately at accept** (it is not audio and never
waits behind playback), while synthesis and playback of **voice lines only** run
asynchronously from a **global serial play queue** — one voice at a time across all
sessions and hosts, a new line never starts while another plays, and the in-flight line is
never interrupted. A `voice_enabled: false` request is banner-only: it never enters the
queue and can never delay or supersede a queued voice line. Queued voice lines coalesce
newest-per-session (an older *queued* line from the same `session_id` is replaced and
recorded `superseded` — its banner already showed) and age out (`dropped-stale`) past
`ECHO_PLAY_QUEUE_AGE_CAP_MS`; a hung player is bounded by the queue's watchdog
(`ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS`). Knobs in [`configuration.md`](configuration.md).

*Compatibility note (pre-Phase-2 callers):* the response stays 2xx, so `response.ok`
remains `true` and callers that treat any 2xx as success — including the shipped adapters,
which only log the status — are unaffected. The semantics shift from "delivered" to
"accepted": a `202` no longer means the line was spoken. True playback outcome now lives in
the audio-lifecycle log (`~/.agents/Echo/audio-lifecycle.jsonl`), where each request's row
records a `disposition` — `played` (reached the player; carries the measured play window
unless muted), `superseded`, `dropped-stale` (waited past the age cap at dequeue, or
evicted by the depth cap at enqueue — `disposition_reason` says which), or
`held-for-capture` (skipped at speak time because an external mic capture was live — see
`ECHO_CAPTURE_STATE_PATH` in [`configuration.md`](configuration.md); the banner still
showed). Voice-disabled lines are not logged (the lifecycle log records spoken lines only).

## `POST /notify/personality`

Compatibility endpoint for callers that only provide a `message`. Always voice-enabled,
default title, identity voice; same validation and response shape (success message
`"Personality notification queued"`). Lines feed the same global play queue and ack
`202` on receipt; a `session_id` here coalesces against `/notify` lines from the same
session (one queue, one key).

## `POST /mute`

Global runtime mute (#83). While muted, notifications are accepted, logged, and
voice-resolved normally — audio alone is suppressed across **every** provider, including the
macOS `say` fallback. Muted lines are not held for later replay: they flow through the play
queue as usual and are suppressed at speak time; the `/notify` contract is unchanged.
The resolution drop-off log tags suppressed events `"muted": true`.

An explicit JSON body sets state; an **empty body toggles** (a one-keystroke hotkey needs no
state knowledge). The response is always the resulting state:

```json
{ "muted": true, "muted_until": "2026-07-03T23:30:00.000Z" }
```

- `muted` (boolean, required in a non-empty body) — target state.
- `duration_minutes` (positive number, optional) — timed mute; omitted = indefinite.
  The mute auto-expires **silently** at the deadline (lazy — voice simply resumes on the
  next notification). Invalid bodies return `400` and leave state untouched.

State persists across daemon restarts, deadline included, in a user-owned state file — its
location and the `ECHO_MUTE_STATE_PATH` override are in [`configuration.md`](configuration.md).
A missing or corrupt state file means unmuted — never a crash.

Day-to-day mute usage — the `scripts/mute.sh` wrapper — lives in
[`operations.md`](operations.md).

### Hotkey bindings

The empty-body toggle is designed for one-keystroke bindings (Raycast, Apple Shortcuts,
Stream Deck — anything that can run a command or make an HTTP request):

```bash
# Raycast Script Command / Stream Deck "System: Open" / any shell binding
curl -fsS -X POST http://localhost:8888/mute

# Explicit variants
curl -fsS -X POST http://localhost:8888/mute -H 'Content-Type: application/json' \
  -d '{"muted": true, "duration_minutes": 30}'   # mute for 30 minutes
curl -fsS -X POST http://localhost:8888/mute -H 'Content-Type: application/json' \
  -d '{"muted": false}'                           # unmute now
```

In Apple Shortcuts, use **Get Contents of URL** → Method `POST` → URL
`http://localhost:8888/mute` (leave the request body empty to toggle).

## `GET /health`

Returns `status`, `port`, `activeProvider` (= `defaultProvider`), `fallbackOrder`, provider
status, `macos_fallback_voice`, pronunciation rule count, emotional preset count, live
`play_queue` (`{depth, in_flight_ms, stalled}` — backlog, how long the current line has
been playing (null when idle), and whether the consumer has outlived its own watchdog), live
`circuit_breakers` state (per-provider `open`/`failures`, plus `threshold` and
`reset_after_ms`), the current mute state (`mute: {muted, muted_until}`), and the capture
guard (`capture_guard: {path, state}` — the resolved recording-state file and its current
reading; `state` is `idle` unless an external mic capture is live).

Each provider entry carries an **egress audit** (`getProviderStatus` in `core/server.ts`):
`enabled`, `healthy`, and `wouldEgress` (true only when the provider is *both* enabled and
makes an outbound network request when used), plus `egressTarget` when `wouldEgress` is
true. This makes the gating guarantee auditable at a glance — a disabled provider always
reports `wouldEgress: false` and omits `egressTarget`. An unhealthy provider may also include
`health_diagnostic` (`phase`, `reason`, `elapsed_ms`, `timeout_ms`, `exit_code`, `stderr`,
`command`). For edge-tts, that health diagnostic is status-only: `/notify` does not skip Edge
just because the import probe is slow or failed. The kokoro entry adds its `endpoint`; the
elevenlabs entry adds `apiKeyConfigured` (reflects only the `voices.json` `apiKey`
indirection, not the bare-env fallback — see [`configuration.md`](configuration.md)). Detail
in [`providers-observability.md`](providers-observability.md).

## `GET /voices`

Read-only projection of the daemon's resolved voice config. This is how a caller asks
"which persona keys exist?" without reading `core/voices.json` off disk — a co-located
checkout is not part of the contract, and the daemon may be running from a different clone
or a different `VOICES_PATH` than the caller can see.

```json
{ "agents": ["architect", "engineer", "themis"], "default_provider": "edgetts" }
```

| Field | Notes |
|---|---|
| `agents` | Sorted persona **name keys** from `voices.json` — exactly the values `/notify` resolves as `voice_id`. Never a raw provider voice id |
| `default_provider` | Same value `/health` reports as `activeProvider` |

Unlike `/health`, this route probes no provider, so it is cheap enough to call per turn.
The Claude Code adapter uses it to validate a `🗣️ <Name>:` persona tag before sending the
key, so an unknown name falls back to the DA voice instead of degrading to the daemon
default (see [`voices.md`](voices.md)). Callers must fail closed: an unreachable daemon or
an unexpected body means "no known personas", never "assume it resolves".

Adapters resolve this URL through `shared/daemon-endpoints.ts` rather than hard-coding a
port, so pointing a host at a second instance is one variable (`ECHO_DAEMON_URL`) —
see [`configuration.md`](configuration.md).

## Unsupported paths

Unsupported POST paths return an explicit JSON `404` with a `supported_endpoints` list; the
universal core does not expose a host-named route. (See the invariants in
[`../AGENTS.md`](../AGENTS.md).)
