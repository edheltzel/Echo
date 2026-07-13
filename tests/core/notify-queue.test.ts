// Phase 2 / U2 — /notify acks on receipt and plays async from the queue (R2):
// 202 returned before playback finishes, the job played by the queue consumer
// (lifecycle row `played`), validation still 4xx BEFORE anything, the banner
// fired at accept time OUTSIDE the queue, and mute still suppresses inside
// the player path.
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
import { waitFor } from "./poll";

const PLAY_MS = 120;

const realSpawn = realChildProcess.spawn;
let spawnedCommands: string[] = [];
let spawnImpl: (...args: any[]) => any = realSpawn;

function stubSpawn(command: string): any {
  spawnedCommands.push(String(command));
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  child.pid = 4242;
  // The playback binary is platform-dependent (afplay on darwin, mpv
  // elsewhere — core/server.ts speak path); delay BOTH so "playback"
  // measurably outlives the request on Linux CI too.
  if (/afplay|mpv/.test(String(command))) {
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
  spawnedCommands = [];
  if (existsSync(LOG)) rmSync(LOG);
  if (existsSync(MUTE_PATH)) rmSync(MUTE_PATH);
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `notify-queue-test-${bucket++}` };
});

afterEach(() => {
  // The lifecycle row is the player's LAST act (the banner fires at accept
  // time), so once a test has polled its row the job is done — no drain wait.
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
  await waitFor(() => readRows().length >= count, timeoutMs, () => `${count} rows; got ${readRows().length}`);
  return readRows();
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
    expect(elapsed).toBeLessThan(PLAY_MS); // ack precedes playback completion

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

  test("banner-only (voice_enabled:false): 202, immediate banner, never queued, no row", async () => {
    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "banner only line", voice_enabled: false, session_id: "sess-banner" }),
    });
    expect(res.status).toBe(202);

    // The banner fires immediately at accept — no queue wait.
    await waitFor(() => spawnedCommands.includes("/usr/bin/osascript"));
    // Never enqueued: no lifecycle row ever appears (per-spoken-line log).
    await Bun.sleep(150);
    expect(readRows().filter((r) => r.session_id === "sess-banner")).toEqual([]);
  });

  test("a banner-only line never supersedes a queued voice line (same session)", async () => {
    // Blocker occupies the player so the voice target is deterministically QUEUED.
    const blocker = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "blocker line", voice_enabled: true, session_id: "sess-blk" }),
    });
    expect(blocker.status).toBe(202);
    const voice = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "queued voice line", voice_enabled: true, session_id: "sess-mix" }),
    });
    expect(voice.status).toBe(202);
    // Same-session banner-only arrives while the voice line is queued.
    const banner = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "banner only same session", voice_enabled: false, session_id: "sess-mix" }),
    });
    expect(banner.status).toBe(202);

    // Both voice lines play; the queued line was NOT superseded by the banner.
    const rows = await waitForRows(2);
    const mix = rows.filter((r) => r.session_id === "sess-mix");
    expect(mix.length).toBe(1);
    expect(mix[0].disposition).toBe("played");
  });

  test("a voice line's banner fires at accept, before playback completes", async () => {
    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "banner precedes play", voice_enabled: true, session_id: "sess-early" }),
    });
    expect(res.status).toBe(202);

    // Banner spawn is observable while the played row does not exist yet.
    await waitFor(() => spawnedCommands.includes("/usr/bin/osascript"));
    expect(readRows().filter((r) => r.session_id === "sess-early")).toEqual([]);
    await waitForRows(1); // then the line still plays to completion
  });

  test("/notify/personality feeds the same queue: 202 + played lifecycle row", async () => {
    const res = await fetch(`http://localhost:${PORT}/notify/personality`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "personality shim line", session_id: "sess-persona" }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(typeof body.request_id).toBe("string");

    const rows = await waitForRows(1);
    expect(rows[0].session_id).toBe("sess-persona");
    expect(rows[0].request_id).toBe(body.request_id);
    expect(rows[0].disposition).toBe("played");
  });

  test("/health reports the play-queue depth (additive field)", async () => {
    const res = await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const health = await res.json();
    expect(typeof health.play_queue.depth).toBe("number");
    expect(health.play_queue.depth).toBeGreaterThanOrEqual(0);
  });
});
