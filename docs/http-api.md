# HTTP API

The universal core (`core/server.ts`) listens on `localhost:8888` and exposes four
endpoints. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for where this sits in the
request flow, and [`../SECURITY.md`](../SECURITY.md) for the trust boundary.

## `POST /notify`

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

Only `message` is required. Use `voice_enabled:false` for silent smoke tests. `voice_id` is
a short **name key** (e.g. `"themis"`), not a raw provider voice id — see
[`voices.md`](voices.md) for resolution.

## `POST /notify/personality`

Compatibility endpoint for callers that only provide a `message`.

## `POST /mute`

Global runtime mute (#83). While muted, notifications are accepted, logged, and
voice-resolved normally — audio alone is suppressed across **every** provider, including the
macOS `say` fallback. Nothing is queued or replayed; the `/notify` contract is unchanged.
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

State persists across daemon restarts, deadline included: it lives in a user-owned file
(`~/Library/Application Support/echo/mute.json` on macOS, `$XDG_STATE_HOME/echo/mute.json`
elsewhere; override with `ECHO_MUTE_STATE_PATH`), written atomically. A missing or corrupt
state file means unmuted — never a crash.

`scripts/mute.sh on [minutes] | off | toggle | status` wraps this endpoint (honors `PORT`).

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

Returns provider status, fallback order, circuit-breaker state, pronunciation rule count,
emotional preset count, and the current mute state (`mute: {muted, muted_until}`).

Each provider entry carries an **egress audit** (`getProviderStatus` in `core/server.ts`):
`enabled`, `healthy`, and `wouldEgress` (true only when the provider is *both* enabled and
makes an outbound network request when used), plus `egressTarget` when `wouldEgress` is
true. This makes the gating guarantee auditable at a glance — a disabled provider always
reports `wouldEgress: false` and omits `egressTarget`. Detail in
[`providers-observability.md`](providers-observability.md).

## Unsupported paths

Unsupported POST paths return an explicit JSON `404` with a `supported_endpoints` list; the
universal core does not expose a host-named route. (See the invariants in
[`../AGENTS.md`](../AGENTS.md).)
