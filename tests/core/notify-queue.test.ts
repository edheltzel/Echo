// Phase 2 / U2 — /notify acks on receipt and plays async from the queue (R2):
// 202 returned before playback finishes, the job played by the queue consumer
// (lifecycle row `played`), validation still 4xx BEFORE enqueue, and mute
// still suppresses inside the player path.
//
// Harness mirrors audio-lifecycle-server.test.ts: PORT=0, spawn stubbed
// (afplay delayed by PLAY_MS so "playback" measurably outlives the request),
// temp log paths, only edgetts enabled. Never stops the singleton server (#47).
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLAY_MS = 120;

const realSpawn = realChildProcess.spawn;
let spawnImpl: (...args: any[]) => any = realSpawn;

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

const TMP = mkdtempSync(join(tmpdir(), "notify-queue-"));
const LOG = join(TMP, "audio-lifecycle.jsonl");
const MUTE_PATH = join(TMP, "mute.json");
process.env.ECHO_AUDIO_LIFECYCLE_LOG = LOG;
process.env.ECHO_RESOLUTION_LOG ??= join(TMP, "resolution.jsonl");
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");
process.env.ECHO_MUTE_STATE_PATH = MUTE_PATH;

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
  if (existsSync(MUTE_PATH)) rmSync(MUTE_PATH);
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `notify-queue-test-${bucket++}` };
});

afterEach(() => {
  spawnImpl = realSpawn;
  for (const name of Object.keys(savedEnabled)) {
    (voicesConfig.providers as any)[name].enabled = savedEnabled[name];
  }
});

afterAll(() => {
  // Never stop the shared singleton server here (AGENTS.md #47).
  rmSync(TMP, { recursive: true, force: true });
});

function readRows(): any[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function waitForRows(count: number, timeoutMs = 5000): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rows = readRows();
    if (rows.length >= count) return rows;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} rows; got ${rows.length}`);
    await Bun.sleep(10);
  }
}

describe("/notify acks on receipt (R2)", () => {
  test("returns 202 before playback finishes; the job plays via the consumer", async () => {
    const started = Date.now();
    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "ack on receipt line", voice_enabled: true, session_id: "sess-202" }),
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(typeof body.request_id).toBe("string");
    // Ack precedes playback: round-trip is queue-insert time, not play time.
    expect(elapsed).toBeLessThan(100);

    // The consumer then plays it and writes the played lifecycle row.
    const rows = await waitForRows(1);
    expect(rows[0].session_id).toBe("sess-202");
    expect(rows[0].request_id).toBe(body.request_id);
    expect(rows[0].disposition).toBe("played");
    expect(rows[0].exit_reason).toBe("completed");
    expect(rows[0].play_time_ms).toBeGreaterThanOrEqual(PLAY_MS - 10);
  });

  test("invalid message still fails 4xx before enqueue — no job, no row", async () => {
    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "x".repeat(501), voice_enabled: true, session_id: "sess-bad" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.message).toContain("Invalid message");

    // Nothing was enqueued: no lifecycle row ever appears for this request.
    await Bun.sleep(200);
    expect(readRows().filter((r) => r.session_id === "sess-bad")).toEqual([]);
  });

  test("muted /notify still suppresses inside the player path (no regression)", async () => {
    writeFileSync(MUTE_PATH, JSON.stringify({ muted: true, muted_until: null }));

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "muted queued line", voice_enabled: true, session_id: "sess-muted" }),
    });
    expect(res.status).toBe(202);

    const rows = await waitForRows(1);
    expect(rows[0].session_id).toBe("sess-muted");
    expect(rows[0].muted).toBe(true);
    expect(rows[0].disposition).toBe("played"); // reached the player; the gate suppressed audio
    expect(rows[0].play_time_ms).toBe(null);
    expect(rows[0].exit_reason).toBe(null);
  });
});
