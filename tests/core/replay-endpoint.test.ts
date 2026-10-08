// FM-449 - POST /replay HTTP contract (validation, empty ring, health, bucket).
// Speak-and-replay behavior lives in notify-queue.test.ts (spawn-stubbed player).
process.env.PORT = "0";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSpeakHistory, REPLAY_DEFAULT_N, REPLAY_MAX_N, SPEAK_HISTORY_CAPACITY } from "../../core/speak-history";

const TMP = mkdtempSync(join(tmpdir(), "replay-ep-"));
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");
process.env.ECHO_MUTE_STATE_PATH ??= join(TMP, "mute.json");

const { server } = await import("../../core/server.ts");
const PORT = (server as any).port;

let bucket = 0;
let HEADERS: Record<string, string>;

async function postReplay(body?: string): Promise<Response> {
  return fetch(`http://localhost:${PORT}/replay`, {
    method: "POST",
    headers: HEADERS,
    body: body ?? "",
  });
}

beforeEach(() => {
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `replay-endpoint-test-${bucket++}` };
  clearSpeakHistory();
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("FM-449 - POST /replay contract", () => {
  test("empty ring → 200 nothing to replay (empty body defaults n=1)", async () => {
    const res = await postReplay();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.replayed).toBe(0);
    expect(body.available).toBe(0);
    expect(body.n).toBe(REPLAY_DEFAULT_N);
    expect(typeof body.request_id).toBe("string");
  });

  test("abusive or non-integer n → 400, ring untouched", async () => {
    for (const body of ['{"n":0}', '{"n":11}', '{"n":-1}', '{"n":1.5}', '{"n":"3"}', "{nope"]) {
      const res = await postReplay(body);
      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.status).toBe("error");
      expect(err.message).toContain("Invalid");
      expect(typeof err.request_id).toBe("string");
    }
  });

  test("/health reports the ring additively", async () => {
    const health = await (await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS })).json();
    expect(health.replay).toEqual({
      available: 0,
      capacity: SPEAK_HISTORY_CAPACITY,
      default_n: REPLAY_DEFAULT_N,
      max_n: REPLAY_MAX_N,
    });
    expect(health.play_queue).toBeDefined();
    expect(health.mute).toBeDefined();
  });

  test("/replay is NOT starved by a /notify flood (dedicated rate-limit bucket)", async () => {
    const floodHeaders = { "Content-Type": "application/json", "x-forwarded-for": "replay-flood-test" };
    for (let i = 0; i < 10; i++) {
      await fetch(`http://localhost:${PORT}/notify`, {
        method: "POST",
        headers: floodHeaders,
        body: JSON.stringify({ message: "flood", voice_enabled: false }),
      });
    }
    const starved = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: floodHeaders,
      body: JSON.stringify({ message: "flood", voice_enabled: false }),
    });
    expect(starved.status).toBe(429);
    const res = await fetch(`http://localhost:${PORT}/replay`, {
      method: "POST",
      headers: floodHeaders,
      body: JSON.stringify({ n: 1 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(0);
  });

  test("unsupported POST lists POST /replay", async () => {
    const res = await fetch(`http://localhost:${PORT}/nope`, {
      method: "POST",
      headers: HEADERS,
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.supported_endpoints).toContain("POST /replay");
  });
});
