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
| `ECHO_CIRCUIT_BREAKER_THRESHOLD` | 2 | 1 |
| `ECHO_EDGETTS_TIMEOUT_MS` | 15000 | 1 |
| `ECHO_EDGETTS_TIMEOUT_MAX_MS` | 60000 | 1 |
| `ECHO_EDGETTS_TIMEOUT_PER_CHAR_MS` | 20 | 0 |
| `ECHO_EDGETTS_HEALTH_TIMEOUT_MS` | 3000 | 1 |
| `ECHO_EDGETTS_SYNTH_RETRIES` | 1 | 0 |
| `ECHO_EDGETTS_SYNTH_BACKOFF_MS` | 250 | 1 |

The legacy `VOICESYSTEM_*` names for these knobs still work as deprecated silent
fallbacks (see [`configuration.md`](configuration.md#deprecated-environment-variables)).

The threshold is **global** across edgetts/elevenlabs/kokoro (default 2 tolerates one
isolated post-retry failure; a second consecutive failure still opens the breaker, so
sustained outages are never masked). The breaker stays open for 60s
(`CIRCUIT_BREAKER_RESET_MS`) before half-opening for a retest.

`ECHO_EDGETTS_TIMEOUT_MS` is the base synthesis budget. The actual per-attempt budget is
adaptive: `base + (message length × ECHO_EDGETTS_TIMEOUT_PER_CHAR_MS)`, capped at
`ECHO_EDGETTS_TIMEOUT_MAX_MS`. The health timeout is diagnostic-only for `/health`/startup;
`/notify` does **not** skip edge-tts just because the Python import probe is slow. On the hot
path, edge-tts is skipped only when disabled or when the circuit breaker is already open from
real synthesis failures.

Worst-case first-turn latency when edge-tts is down is bounded by the adaptive timeout ×
`(retries + 1)` plus backoff before fallback; mitigated because `speakWithFallback` is
single-pass, so the same turn still falls through to local `say`.
