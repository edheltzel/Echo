# Reliability — provider circuit breaker

`core/circuit-breaker.ts` tracks **provider** (synthesis/network) failures per TTS provider
and opens after a shared threshold, skipping the provider for a cooldown then half-opening to
retest. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for where this sits, and
[`providers-observability.md`](providers-observability.md) for how breaker state surfaces in
`/health` and the drop-off log.

## Attribution rule

A **local playback** failure (afplay/mpv) is NOT a provider failure and must never call
`recordProviderFailure` — `EdgeTTSProvider.speak` splits synthesis (governed by the breaker,
retried) from playback (local, never opens the breaker). edge-tts is Microsoft's **online**
WebSocket service, so transient blips are retried before a failure is recorded. (A local
audio problem must not disable a healthy online provider.)

## Tunable env knobs

All parsed through `core/env.ts` `parseBoundedInt`, which falls back to the default for
missing/non-numeric/below-floor values:

| Env var | Default | Floor |
|---|---|---|
| `VOICESYSTEM_CIRCUIT_BREAKER_THRESHOLD` | 2 | 1 |
| `VOICESYSTEM_EDGETTS_TIMEOUT_MS` | 15000 | 1 |
| `VOICESYSTEM_EDGETTS_SYNTH_RETRIES` | 1 | 0 |
| `VOICESYSTEM_EDGETTS_SYNTH_BACKOFF_MS` | 250 | 1 |

The threshold is **global** across edgetts/elevenlabs/kokoro (default 2 tolerates one
isolated post-retry failure; a second consecutive failure still opens the breaker, so
sustained outages are never masked). The breaker stays open for 60s
(`CIRCUIT_BREAKER_RESET_MS`) before half-opening for a retest.

Worst-case first-turn latency when edge-tts is down is ~30s (2 attempts × 15s + backoff)
before fallback; mitigated because `speakWithFallback` is single-pass, so the same turn still
falls through to local `say`.
