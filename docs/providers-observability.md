# Providers, egress gating & observability

How the TTS providers are gated for network egress, and the structured log that makes
voice-selection drop-offs observable. See [`../SECURITY.md`](../SECURITY.md) for the egress
posture summary and [`reliability.md`](reliability.md) for the circuit breaker.

## Provider egress gating

A **disabled** provider makes **zero** outbound network calls — no synthesis request and no
auth/health probe. The guarantee is structural, not best-effort:

- `speakWithFallback` (`core/server.ts`) checks `provider.isEnabled()` and `continue`s
  **before** ever calling `isHealthy()` or `speak()`, so a disabled provider's network paths
  are unreachable.
- `getProviderStatus` only runs `isHealthy()` `if (enabled)`, so the `/health` probe never
  reaches a disabled provider either.
- `ElevenLabsProvider.isEnabled()` requires `enabled:true` **and** an API key; `isHealthy()`
  makes no network call (the key is read in the constructor). With ElevenLabs disabled,
  nothing ever reaches `api.elevenlabs.io`.
- `KokoroProvider` is contacted **only when enabled** — `isHealthy()` short-circuits on
  `!isEnabled()` before probing its endpoint, and `speak()` is gated by the same
  `isEnabled()` check upstream.

Proven by `tests/core/egress-gating.test.ts` (spies `fetch`; asserts zero calls for a
disabled provider across both `speakWithFallback` and `getProviderStatus`, and that enabling
a provider is the only thing that flips egress on).

**edge-tts egresses by default.** The default provider (`edgetts`) is Microsoft's **online**
TTS service, so "no external calls" is not the out-of-the-box state — edge-tts leaves the
host to Microsoft (see #1). For a fully-local setup, run a local provider (`kokoro` against a
local endpoint, or `say`) and disable `edgetts`/`elevenlabs`; `/health` `wouldEgress` flags
then read `false`/local for every enabled provider.

## Voice-resolution drop-off log (#24)

To make voice-selection drop-offs observable — why a `/notify` used the default voice
(unresolved `voice_id`, provider failure, circuit-breaker open, fallback hop) — the daemon
appends **one structured JSONL event per voice-enabled `/notify`**. This is host-neutral and
lives entirely in `core/server.ts`: a self-contained helper block (`writeResolutionEvent` +
rolling `pruneResolutionLog` + `classifyResolution`, just above `speakWithFallback`), plus
`speakWithFallback` returning a per-provider `attempts` trail and the actual `voice` used,
and a single `writeResolutionEvent` call in `sendNotification`'s voice-enabled path.

- **Path (user-owned, never `/tmp`/repo):** macOS
  `~/Library/Logs/atlas-voicesystem/voice-resolution.jsonl`, else `$XDG_STATE_HOME`/
  `~/.local/state` under `atlas-voicesystem/`. Override `VOICESYSTEM_RESOLUTION_LOG`.
  **Separate** from the human log `~/Library/Logs/atlas-voicesystem.log`.
- **Retention:** single size-capped file, `~1MB` default (override
  `VOICESYSTEM_RESOLUTION_LOG_MAX_BYTES`, floor 1KB via `parseBoundedInt`). On each write,
  oldest whole lines are pruned to stay under the cap; the newest line is always kept. No
  external deps, no time-based rotation.
- **Best-effort:** all write/prune errors are swallowed — logging must never break a
  `/notify`.
- **Fields:** `ts`, `requested_voice_id` (`null` if omitted), `resolution`
  (`identity-default` \| `identity` \| `agent-key` \| `elevenlabs-id` \| `fallback`),
  `resolution_reason` (fallback only), `provider` (or `none`), `voice` (actual, or `null`),
  `hops` (providers skipped/failed before the chosen one), `attempts[]` (`{provider,
  outcome}` where outcome ∈ `success`/`failed`/`unhealthy`/`circuit-open`/`disabled`),
  `success`. `classifyResolution` derives the resolution from the `VoiceMapping`
  `getVoiceMapping` already returned (not a re-query), so the log can never disagree with the
  actual resolution. A `circuit-open` outcome is read from the imported `circuitBreakers` map
  (the provider's health probe consults `shouldSkipProvider`).

Proven by `tests/core/resolution-log.test.ts`: one `/notify` writes exactly one event with
the expected fields, and the rolling prune is driven past the cap (file never exceeds it,
newest lines kept, a single over-cap line is still retained).
