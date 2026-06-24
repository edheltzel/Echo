# HTTP API

The universal core (`core/server.ts`) listens on `localhost:8888` and exposes three
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

## `GET /health`

Returns provider status, fallback order, circuit-breaker state, pronunciation rule count,
and emotional preset count.

Each provider entry carries an **egress audit** (`getProviderStatus` in `core/server.ts`):
`enabled`, `healthy`, and `wouldEgress` (true only when the provider is *both* enabled and
makes an outbound network request when used), plus `egressTarget` when `wouldEgress` is
true. This makes the gating guarantee auditable at a glance — a disabled provider always
reports `wouldEgress: false` and omits `egressTarget`. Detail in
[`providers-observability.md`](providers-observability.md).

## Unsupported paths

Unsupported POST paths return an explicit JSON `404` with a `supported_endpoints` list; the
universal core does not expose a PAI-named route. (See the invariants in
[`../AGENTS.md`](../AGENTS.md).)
