// =============================================================================
// Circuit Breaker — host-neutral provider failure tracking
// =============================================================================
//
// Tracks consecutive PROVIDER failures (synthesis / network) per TTS provider.
// Opens after a threshold to skip a failing provider for a cooldown window,
// then half-opens to retest.
//
// Attribution rule (issue #25): only genuine provider failures are recorded
// here. Local audio playback failures (afplay/mpv) are NOT provider failures
// and must never be passed to recordProviderFailure — a local audio problem
// must not disable a healthy online provider.

export interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
}

export type CircuitBreakerLogger = (
  level: "info" | "warn",
  message: string,
) => void;

// Recorded provider failures required to open the breaker. SHARED across every
// provider (edgetts/elevenlabs/kokoro). Default 2 tolerates one isolated
// post-retry failure; a second consecutive failure still opens the breaker, so
// sustained outages are never masked. Override with VOICESYSTEM_CIRCUIT_BREAKER_THRESHOLD.
export const CIRCUIT_BREAKER_THRESHOLD =
  Number(process.env.VOICESYSTEM_CIRCUIT_BREAKER_THRESHOLD) || 2;

// How long an open breaker stays open before half-opening for a retest.
export const CIRCUIT_BREAKER_RESET_MS = 60_000;

export const circuitBreakers: Record<string, CircuitBreakerState> = {
  edgetts: { failures: 0, lastFailure: 0, isOpen: false },
  elevenlabs: { failures: 0, lastFailure: 0, isOpen: false },
  kokoro: { failures: 0, lastFailure: 0, isOpen: false },
};

let logger: CircuitBreakerLogger = () => {};

// Inject the host's structured logger. Defaults to a no-op so the module is
// silent (and host-neutral) until wired up.
export function setCircuitBreakerLogger(fn: CircuitBreakerLogger): void {
  logger = fn;
}

export function recordProviderSuccess(provider: string): void {
  const breaker = circuitBreakers[provider];
  if (!breaker) return;

  breaker.failures = 0;
  if (breaker.isOpen) {
    logger("info", `🟢 Circuit CLOSED - ${provider} recovered`);
    breaker.isOpen = false;
  }
}

export function recordProviderFailure(provider: string): void {
  const breaker = circuitBreakers[provider];
  if (!breaker) return;

  breaker.failures++;
  breaker.lastFailure = Date.now();

  if (breaker.failures >= CIRCUIT_BREAKER_THRESHOLD && !breaker.isOpen) {
    breaker.isOpen = true;
    logger("warn", `🔴 Circuit OPEN - ${provider} disabled, using fallback`);
  }
}

export function shouldSkipProvider(provider: string): boolean {
  const breaker = circuitBreakers[provider];
  if (!breaker || !breaker.isOpen) return false;

  if (Date.now() - breaker.lastFailure > CIRCUIT_BREAKER_RESET_MS) {
    logger("info", `🟡 Circuit HALF-OPEN - testing ${provider}`);
    return false;
  }

  return true;
}
