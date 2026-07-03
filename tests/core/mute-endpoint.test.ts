// Issue #83 — POST /mute endpoint + /health mute block.
//
// KTD4 semantics: an explicit JSON body sets state ({"muted": bool,
// "duration_minutes"?: n}); an EMPTY body toggles (one-keystroke hotkeys need
// no state knowledge). The response always returns the resulting state
// {muted, muted_until}. Invalid bodies → 400 with state untouched.
// KTD5: /health gains an additive mute block; nothing existing changes shape.
process.env.PORT = "0";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "mute-ep-"));
const MUTE_PATH = join(TMP, "mute.json");
process.env.ECHO_MUTE_STATE_PATH = MUTE_PATH;
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");

const { readMuteState, writeMuteState } = await import("../../core/mute.ts");
const { server } = await import("../../core/server.ts");
const PORT = (server as any).port;

// Per-test rate-limit bucket — the shared daemon caps requests per client IP
// (10/min), and this file alone exceeds that on one bucket.
let bucket = 0;
let HEADERS: Record<string, string>;

async function postMute(body?: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/mute`, { method: "POST", headers: HEADERS, body: body ?? "" });
}

beforeEach(() => {
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `mute-endpoint-test-${bucket++}` };
  if (existsSync(MUTE_PATH)) rmSync(MUTE_PATH);
});

afterAll(() => {
  // Never stop the shared singleton server (#47 flake). Removing TMP leaves the
  // env path pointing at a missing file = unmuted for sibling test files.
  rmSync(TMP, { recursive: true, force: true });
});

describe("issue #83 — POST /mute explicit set", () => {
  test('{"muted": true} → indefinite mute, response reflects state', async () => {
    const res = await postMute(JSON.stringify({ muted: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ muted: true, muted_until: null });
    expect(readMuteState(MUTE_PATH)).toEqual({ muted: true, muted_until: null });
  });

  test('{"muted": true, "duration_minutes": 30} → deadline ≈ now+30m', async () => {
    const before = Date.now();
    const res = await postMute(JSON.stringify({ muted: true, duration_minutes: 30 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.muted).toBe(true);
    const deadline = Date.parse(body.muted_until);
    expect(deadline).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  test('{"muted": false} while timed-muted → unmuted, deadline cleared', async () => {
    writeMuteState({ muted: true, muted_until: new Date(Date.now() + 60_000).toISOString() });
    const res = await postMute(JSON.stringify({ muted: false }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ muted: false, muted_until: null });
    expect(readMuteState(MUTE_PATH)).toEqual({ muted: false, muted_until: null });
  });
});

describe("issue #83 — POST /mute empty-body toggle", () => {
  test("empty body twice → toggles on then off", async () => {
    const first = await postMute();
    expect(first.status).toBe(200);
    expect((await first.json()).muted).toBe(true);
    expect(readMuteState(MUTE_PATH).muted).toBe(true);

    const second = await postMute();
    expect(second.status).toBe(200);
    expect((await second.json()).muted).toBe(false);
    expect(readMuteState(MUTE_PATH).muted).toBe(false);
  });
});

describe("issue #83 — POST /mute invalid bodies → 400, state untouched", () => {
  const cases: [string, string][] = [
    ["non-boolean muted", JSON.stringify({ muted: "yes" })],
    ["missing muted key", JSON.stringify({ duration_minutes: 30 })],
    ["negative duration", JSON.stringify({ muted: true, duration_minutes: -5 })],
    ["NaN duration", JSON.stringify({ muted: true, duration_minutes: "soon" })],
    ["malformed JSON", "{nope"],
  ];

  for (const [name, body] of cases) {
    test(name, async () => {
      writeMuteState({ muted: true, muted_until: null }); // pre-existing state
      const res = await postMute(body);
      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.status).toBe("error");
      // State untouched by the rejected request.
      expect(readMuteState(MUTE_PATH)).toEqual({ muted: true, muted_until: null });
    });
  }
});

describe("issue #83 — /health mute block", () => {
  test("shows mute state in both states; existing fields unchanged", async () => {
    const unmuted = await (await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS })).json();
    expect(unmuted.status).toBe("healthy");
    expect(unmuted.mute).toEqual({ muted: false, muted_until: null });

    writeMuteState({ muted: true, muted_until: null });
    const muted = await (await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS })).json();
    expect(muted.mute).toEqual({ muted: true, muted_until: null });

    // Additive only: every pre-mute field is still present.
    for (const key of ["status", "port", "providers", "fallbackOrder", "circuit_breakers", "activeProvider"]) {
      expect(muted).toHaveProperty(key);
      expect(unmuted).toHaveProperty(key);
    }
  });
});

describe("issue #83 — persistence across module re-read", () => {
  test("state set via endpoint is re-read from disk identically", async () => {
    await postMute(JSON.stringify({ muted: true, duration_minutes: 60 }));
    const onDisk = readMuteState(MUTE_PATH);
    expect(onDisk.muted).toBe(true);
    expect(typeof onDisk.muted_until).toBe("string");
  });
});
