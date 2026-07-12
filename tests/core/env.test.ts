import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoundedInt, primeEchoFileEnv, resolveEchoEnv } from "../../core/env";

// parseBoundedInt is the single guard behind every numeric env override in the
// voice system (issue #25). A degenerate value (NaN / negative / below floor)
// must fall back to the documented DEFAULT, never to a value that masks a real
// outage (0ms timeout, 0 retries, threshold that opens on the first failure).
describe("parseBoundedInt — degenerate env values fall back to default", () => {
  test("valid in-range values are parsed", () => {
    expect(parseBoundedInt("30000", 15000, 1)).toBe(30000);
    expect(parseBoundedInt("3", 1, 0)).toBe(3);
  });

  test("non-numeric / undefined / empty fall back", () => {
    expect(parseBoundedInt("abc", 15000, 1)).toBe(15000);
    expect(parseBoundedInt(undefined, 15000, 1)).toBe(15000);
    expect(parseBoundedInt("", 15000, 1)).toBe(15000);
    expect(parseBoundedInt("   ", 15000, 1)).toBe(15000);
  });

  test("values below the floor fall back (negative always rejected)", () => {
    expect(parseBoundedInt("-5", 15000, 1)).toBe(15000);
    expect(parseBoundedInt("-1", 2, 1)).toBe(2);
  });

  describe("call-site floors", () => {
    // timeout floor 1: 0ms would make setTimeout fire instantly → every synth
    // "times out" → false outage.
    test("EDGETTS_TIMEOUT_MS floor rejects 0", () => {
      expect(parseBoundedInt("0", 15000, 1)).toBe(15000);
      expect(parseBoundedInt("1", 15000, 1)).toBe(1);
    });

    // retries floor 0: 0 retries is a LEGITIMATE config (single attempt), so it
    // must be honored — only NaN/negative fall back.
    test("EDGETTS_SYNTH_RETRIES floor allows 0 but rejects NaN/negative", () => {
      expect(parseBoundedInt("0", 1, 0)).toBe(0);
      expect(parseBoundedInt("abc", 1, 0)).toBe(1);
      expect(parseBoundedInt("-2", 1, 0)).toBe(1);
    });

    // backoff floor 1.
    test("EDGETTS_SYNTH_BACKOFF_MS floor rejects 0", () => {
      expect(parseBoundedInt("0", 250, 1)).toBe(250);
      expect(parseBoundedInt("500", 250, 1)).toBe(500);
    });

    // threshold floor 1: 0/negative would open the breaker on (or before) the
    // first failure → masks nothing but defeats the tuning; falls back to 2.
    test("CIRCUIT_BREAKER_THRESHOLD floor rejects 0 and negative", () => {
      expect(parseBoundedInt("0", 2, 1)).toBe(2);
      expect(parseBoundedInt("-1", 2, 1)).toBe(2);
      expect(parseBoundedInt("3", 2, 1)).toBe(3);
    });
  });
});

// resolveEchoEnv is the import-pure replacement for the daemon's old
// hydrate-process.env-at-import loop (the pi-adapter "Atlas" pollution):
// live process value wins, env-file values are a read-only fallback, and
// resolving NEVER writes to process.env.
describe("resolveEchoEnv — import-pure env resolution", () => {
  afterEach(() => {
    primeEchoFileEnv(undefined); // restore lazy real-file loading
    delete process.env.ECHO_ENV_TEST_KEY;
  });

  test("a live process value wins over the file layer", () => {
    primeEchoFileEnv({ ECHO_ENV_TEST_KEY: "from-file" });
    process.env.ECHO_ENV_TEST_KEY = "from-process";
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("from-process");
  });

  test("falls back to the file layer when the process value is absent", () => {
    primeEchoFileEnv({ ECHO_ENV_TEST_KEY: "from-file" });
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("from-file");
  });

  test("resolving never mutates process.env (import-purity contract)", () => {
    primeEchoFileEnv({ ECHO_ENV_TEST_KEY: "from-file" });
    expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("from-file");
    expect(process.env.ECHO_ENV_TEST_KEY).toBeUndefined();
  });

  test("reads a real env file via ECHO_ENV_PATHS (quotes stripped, first wins)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "echo-env-"));
    try {
      writeFileSync(join(tmp, "a.env"), 'ECHO_ENV_TEST_KEY="first"\n');
      writeFileSync(join(tmp, "b.env"), "ECHO_ENV_TEST_KEY=second\n");
      const saved = process.env.ECHO_ENV_PATHS;
      process.env.ECHO_ENV_PATHS = `${join(tmp, "a.env")}:${join(tmp, "b.env")}`;
      primeEchoFileEnv(undefined); // force a fresh lazy load with these paths
      try {
        expect(resolveEchoEnv("ECHO_ENV_TEST_KEY")).toBe("first");
        expect(process.env.ECHO_ENV_TEST_KEY).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.ECHO_ENV_PATHS;
        else process.env.ECHO_ENV_PATHS = saved;
        primeEchoFileEnv(undefined);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
