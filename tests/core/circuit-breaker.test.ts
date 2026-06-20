import { beforeEach, describe, expect, test } from "bun:test";
import {
  CIRCUIT_BREAKER_RESET_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  circuitBreakers,
  recordProviderFailure,
  recordProviderSuccess,
  shouldSkipProvider,
} from "../../core/circuit-breaker";

// Reset shared breaker state before each test — the breaker map is a module
// singleton.
beforeEach(() => {
  for (const breaker of Object.values(circuitBreakers)) {
    breaker.failures = 0;
    breaker.lastFailure = 0;
    breaker.isOpen = false;
  }
});

describe("circuit breaker — issue #25 fallback tuning", () => {
  test("default threshold tolerates one isolated failure (>= 2)", () => {
    // Tuning C: a single post-retry failure must not open the breaker.
    expect(CIRCUIT_BREAKER_THRESHOLD).toBeGreaterThanOrEqual(2);
  });

  test("a single transient failure does NOT open the breaker", () => {
    recordProviderFailure("edgetts");
    expect(circuitBreakers.edgetts.isOpen).toBe(false);
    expect(shouldSkipProvider("edgetts")).toBe(false);
  });

  test("transient failure then success leaves the breaker closed and reset", () => {
    recordProviderFailure("edgetts");
    recordProviderSuccess("edgetts");
    expect(circuitBreakers.edgetts.isOpen).toBe(false);
    expect(circuitBreakers.edgetts.failures).toBe(0);
    expect(shouldSkipProvider("edgetts")).toBe(false);
  });

  test("sustained failures (>= threshold) STILL open the breaker — no masking", () => {
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      recordProviderFailure("edgetts");
    }
    expect(circuitBreakers.edgetts.isOpen).toBe(true);
    expect(shouldSkipProvider("edgetts")).toBe(true);
  });

  test("an open breaker half-opens for a retest after the reset window", () => {
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      recordProviderFailure("edgetts");
    }
    expect(shouldSkipProvider("edgetts")).toBe(true);

    // Simulate the cooldown elapsing.
    circuitBreakers.edgetts.lastFailure = Date.now() - (CIRCUIT_BREAKER_RESET_MS + 1_000);
    expect(shouldSkipProvider("edgetts")).toBe(false); // half-open: allow a retest
    expect(circuitBreakers.edgetts.isOpen).toBe(true); // stays open until success/failure
  });

  test("a success during half-open closes the breaker", () => {
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      recordProviderFailure("edgetts");
    }
    circuitBreakers.edgetts.lastFailure = Date.now() - (CIRCUIT_BREAKER_RESET_MS + 1_000);
    recordProviderSuccess("edgetts");
    expect(circuitBreakers.edgetts.isOpen).toBe(false);
    expect(circuitBreakers.edgetts.failures).toBe(0);
  });

  test("NOT recording a failure leaves the breaker closed (playback-failure attribution)", () => {
    // Attribution fix B: a local playback failure must not touch the breaker.
    // The provider's speak() records SUCCESS once synthesis works, then returns
    // false on playback failure WITHOUT recording a provider failure — so the
    // edge-tts breaker stays closed.
    recordProviderSuccess("edgetts"); // synthesis succeeded
    // (no recordProviderFailure call for the playback failure)
    expect(circuitBreakers.edgetts.isOpen).toBe(false);
    expect(circuitBreakers.edgetts.failures).toBe(0);
    expect(shouldSkipProvider("edgetts")).toBe(false);
  });

  test("the breaker map is shared across providers (threshold blast radius)", () => {
    // Tuning C is a GLOBAL threshold change — document the shared scope.
    expect(Object.keys(circuitBreakers).sort()).toEqual([
      "edgetts",
      "elevenlabs",
      "kokoro",
    ]);
    for (let i = 0; i < CIRCUIT_BREAKER_THRESHOLD; i++) {
      recordProviderFailure("elevenlabs");
    }
    expect(circuitBreakers.elevenlabs.isOpen).toBe(true);
    expect(circuitBreakers.edgetts.isOpen).toBe(false); // independent state per provider
  });

  test("unknown providers are ignored safely", () => {
    expect(() => recordProviderFailure("nope")).not.toThrow();
    expect(() => recordProviderSuccess("nope")).not.toThrow();
    expect(shouldSkipProvider("nope")).toBe(false);
  });
});
