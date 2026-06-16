import { describe, expect, test } from "bun:test";
import { edgeRateFromSpeed } from "../../core/edge-rate";

describe("edgeRateFromSpeed", () => {
  test("converts a faster speed to a signed percentage", () => {
    expect(edgeRateFromSpeed(1.08)).toBe("+8%");
    expect(edgeRateFromSpeed(1.02)).toBe("+2%");
  });

  test("converts a slower speed to a negative percentage", () => {
    expect(edgeRateFromSpeed(0.94)).toBe("-6%");
    expect(edgeRateFromSpeed(0.96)).toBe("-4%");
    expect(edgeRateFromSpeed(0.98)).toBe("-2%");
  });

  test("speed of exactly 1.0 uses the fallback rate", () => {
    expect(edgeRateFromSpeed(1.0, "+0%")).toBe("+0%");
    expect(edgeRateFromSpeed(1.0, "+5%")).toBe("+5%");
  });

  test("absent speed uses the fallback rate", () => {
    expect(edgeRateFromSpeed(undefined, "+5%")).toBe("+5%");
  });

  test("no speed and no fallback yields a safe default", () => {
    expect(edgeRateFromSpeed(undefined)).toBe("+0%");
    expect(edgeRateFromSpeed(1.0)).toBe("+0%");
  });

  test("rounds to an integer percentage (no fractional %)", () => {
    expect(edgeRateFromSpeed(1.006)).toBe("+1%"); // rounds up
    expect(edgeRateFromSpeed(1.004)).toBe("+0%"); // rounds down
    expect(edgeRateFromSpeed(1.1234)).toBe("+12%");
  });
});
