// Phase 2 / U5 — the overlap acceptance test (R1/R7 headline).
//
// Fires concurrent /notify requests against an ephemeral-port daemon with a
// deterministic injected player (the spawn stub delays afplay's exit by a
// fixed PLAY_MS; no real audio) and asserts the audio-lifecycle rows record
// NON-INTERSECTING play windows: one voice at a time, globally. This test
// fails against pre-serialization behavior (each /notify spawned its own
// concurrent afplay → intersecting windows) — the red→green anchor for the
// serialization plan.
//
// Harness mirrors audio-lifecycle-server.test.ts: PORT=0, node:child_process
// spawn stubbed so nothing shells out, ECHO_AUDIO_LIFECYCLE_LOG pointed at a
// temp file, only edgetts enabled. Never stops the singleton server (#47).
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "./poll";

// Deterministic "playback duration" for the stubbed afplay. Long enough that
// concurrent requests would demonstrably overlap without serialization, and
// that a burst can be enqueued while the first line is still playing.
const PLAY_MS = 250;

const realSpawn = realChildProcess.spawn;
let spawnImpl: (...args: any[]) => any = realSpawn;

// Injected player: afplay "plays" for PLAY_MS then exits 0; every other
// process (edge-tts synthesis, osascript) exits immediately.
function stubSpawn(command: string): any {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  child.pid = 4242;
  if (String(command).includes("afplay")) {
    setTimeout(() => child.emit("exit", 0), PLAY_MS);
  } else {
    queueMicrotask(() => child.emit("exit", 0));
  }
  return child;
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: (realChildProcess as any).default ?? realChildProcess,
  spawn: (...args: any[]) => spawnImpl(...args),
}));

const TMP = mkdtempSync(join(tmpdir(), "playback-overlap-"));
const LOG = join(TMP, "audio-lifecycle.jsonl");
process.env.ECHO_AUDIO_LIFECYCLE_LOG = LOG;
process.env.ECHO_RESOLUTION_LOG ??= join(TMP, "resolution.jsonl");
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");
process.env.ECHO_MUTE_STATE_PATH ??= join(TMP, "mute.json");

const { server, voicesConfig } = await import("../../core/server.ts");
const PORT = (server as any).port;

let savedEnabled: Record<string, boolean>;
let bucket = 0;
let HEADERS: Record<string, string>;

beforeEach(() => {
  spawnImpl = stubSpawn;
  savedEnabled = {};
  for (const name of Object.keys(voicesConfig.providers)) {
    savedEnabled[name] = (voicesConfig.providers as any)[name].enabled;
    (voicesConfig.providers as any)[name].enabled = false;
  }
  (voicesConfig.providers as any).edgetts.enabled = true;
  if (existsSync(LOG)) rmSync(LOG);
  // Per-test rate-limit bucket so bursts never starve the suite-wide bucket.
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `overlap-test-${bucket++}` };
});

afterEach(async () => {
  // Drain guard: rows land just before the job's final osascript spawn.
  await Bun.sleep(25);
  spawnImpl = realSpawn;
  for (const name of Object.keys(savedEnabled)) {
    (voicesConfig.providers as any)[name].enabled = savedEnabled[name];
  }
});

afterAll(() => {
  // Never stop the shared singleton server here (AGENTS.md #47).
  rmSync(TMP, { recursive: true, force: true });
});

function notify(message: string, sessionId: string) {
  return fetch(`http://localhost:${PORT}/notify`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ message, voice_enabled: true, session_id: sessionId }),
  });
}

function readRows(): any[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// Playback is async behind the queue; poll the lifecycle log for the rows.
async function waitForRows(count: number, timeoutMs = 5000): Promise<any[]> {
  await waitFor(() => readRows().length >= count, timeoutMs, () => `${count} lifecycle rows; got ${readRows().length}`);
  return readRows();
}

// Sorted play windows must not intersect: each next line starts at or after
// the previous line ended. (Equal boundaries are fine — serial back-to-back.)
function expectNonIntersecting(rows: any[]): void {
  const windows = rows
    .map((r) => ({ start: Date.parse(r.play_started_at), end: Date.parse(r.play_ended_at) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i++) {
    expect(windows[i].start).toBeGreaterThanOrEqual(windows[i - 1].end);
  }
}

describe("playback overlap acceptance (R1/R7)", () => {
  test("two concurrent /notify from distinct sessions play serially — non-intersecting windows", async () => {
    const [a, b] = await Promise.all([
      notify("first overlapping line", "sess-a"),
      notify("second overlapping line", "sess-b"),
    ]);
    // Ack on receipt (R2): accepted, not played.
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

    const rows = await waitForRows(2);
    const played = rows.filter((r) => r.play_started_at && r.play_ended_at);
    expect(played.length).toBe(2);
    for (const row of played) {
      expect(row.disposition).toBe("played");
      expect(row.play_time_ms).toBeGreaterThanOrEqual(PLAY_MS - 10);
    }
    expectNonIntersecting(played);
  });

  test("concurrent same-session lines coalesce: one superseded, the survivor plays alone", async () => {
    // Occupy the player with a distinct-session blocker so the same-session
    // pair is deterministically QUEUED (not in-flight) when coalescing runs.
    const blocker = await notify("blocker line", "sess-block");
    expect(blocker.status).toBe(202);

    const older = await notify("older same-session line", "sess-same");
    const newer = await notify("newer same-session line", "sess-same");
    expect(older.status).toBe(202);
    expect(newer.status).toBe(202);

    // 3 rows: blocker played, one sess-same superseded, one sess-same played.
    const rows = await waitForRows(3);
    const sameRows = rows.filter((r) => r.session_id === "sess-same");
    expect(sameRows.length).toBe(2);

    const superseded = sameRows.filter((r) => r.disposition === "superseded");
    const played = sameRows.filter((r) => r.disposition === "played");
    expect(superseded.length).toBe(1);
    expect(played.length).toBe(1);
    expect(superseded[0].play_time_ms).toBe(null); // never played
    expect(played[0].play_started_at).not.toBe(null);

    const blockerRow = rows.find((r) => r.session_id === "sess-block");
    expectNonIntersecting([blockerRow, played[0]]);
  });

  test("a burst of N distinct sessions is fully serialized", async () => {
    const N = 4;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) => notify(`burst line number ${i}`, `sess-burst-${i}`)),
    );
    for (const res of responses) expect(res.status).toBe(202);

    const rows = await waitForRows(N, 8000);
    const played = rows.filter((r) => r.disposition === "played");
    expect(played.length).toBe(N);
    expectNonIntersecting(played);
  });
});
