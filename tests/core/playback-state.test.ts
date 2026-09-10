// Playback-state signal file (#106): Echo publishes speaker occupancy so
// other processes can poll a user-owned JSON file. Unit half: atomic write,
// tolerant reads, pid-liveness, empty-path disable. Queue half: the same
// play-queue seams /health already reads (job start → speaking, settle →
// idle, enqueue/drop → queue_depth). No server, no afplay.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPlaybackSignal,
  readPlaybackState,
  resolvePlaybackStatePath,
  writePlaybackState,
} from "../../core/playback-state";
import { primeEchoFileEnv } from "../../core/env";
import { PlayQueue, type PlayJob } from "../../core/play-queue";
import { waitFor } from "./poll";

const TMP = mkdtempSync(join(tmpdir(), "playback-state-"));
const STATE = join(TMP, "playback-state.json");

const savedPath = process.env.ECHO_PLAYBACK_STATE_PATH;

function job(id: string, sessionId: string | null, receivedAt = Date.now()): PlayJob<string> {
  return { id, sessionId, receivedAt, payload: id };
}

function readFile(path: string): { state: string; queue_depth: number; pid: number; updated_at: string } {
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => {
  process.env.ECHO_PLAYBACK_STATE_PATH = STATE;
  if (existsSync(STATE)) rmSync(STATE);
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.ECHO_PLAYBACK_STATE_PATH;
  else process.env.ECHO_PLAYBACK_STATE_PATH = savedPath;
  primeEchoFileEnv(undefined);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// =============================================================================
// Writer - atomic, best-effort, never throws
// =============================================================================

describe("writePlaybackState", () => {
  test("writes the contract shape and creates the dir without group/other access", () => {
    const dir = join(TMP, "nested", "echo");
    const path = join(dir, "playback-state.json");
    writePlaybackState({ state: "speaking", queue_depth: 2 }, path);

    const rec = readFile(path);
    expect(rec.state).toBe("speaking");
    expect(rec.queue_depth).toBe(2);
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.updated_at).toBe("string");
    expect(Number.isNaN(Date.parse(rec.updated_at))).toBe(false);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  test("write is atomic: no temp-file leftovers, file always parses", () => {
    const dir = join(TMP, "atomic");
    const path = join(dir, "playback-state.json");
    for (let i = 0; i < 20; i++) {
      writePlaybackState({ state: i % 2 === 0 ? "speaking" : "idle", queue_depth: i }, path);
      expect(() => JSON.parse(readFileSync(path, "utf-8"))).not.toThrow();
    }
    const leftovers = readdirSync(dir).filter((f) => f !== "playback-state.json");
    expect(leftovers).toEqual([]);
  });

  test("a write to an unwritable path is swallowed - never throws", () => {
    const blocker = join(TMP, "blocker");
    writeFileSync(blocker, "not-a-dir");
    const underAFile = join(blocker, "playback-state.json");
    expect(() => writePlaybackState({ state: "speaking", queue_depth: 1 }, underAFile)).not.toThrow();
  });

  test("null / empty path is a no-op (does not create a sibling file)", () => {
    const path = join(TMP, "disabled", "playback-state.json");
    expect(() => writePlaybackState({ state: "speaking", queue_depth: 1 }, null)).not.toThrow();
    expect(() => writePlaybackState({ state: "speaking", queue_depth: 1 }, "")).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

// =============================================================================
// Reader - tolerant + pid liveness (mirrors capture-guard.test.ts)
// =============================================================================

describe("readPlaybackState - tolerant reads", () => {
  test("missing file ⇒ idle", () => {
    expect(readPlaybackState(join(TMP, "nope.json"))).toBe("idle");
    expect(readPlaybackSignal(join(TMP, "nope.json")).queue_depth).toBe(0);
  });

  test("corrupt JSON ⇒ idle, never a throw", () => {
    writeFileSync(STATE, "{not json");
    expect(readPlaybackState(STATE)).toBe("idle");
  });

  test("wrong shape ⇒ idle (bad state / non-number pid / non-string updated_at / bad depth)", () => {
    writeFileSync(STATE, JSON.stringify({ state: "listening", queue_depth: 0, pid: process.pid, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toBe("idle");
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: 0, pid: "4242", updated_at: "x" }));
    expect(readPlaybackState(STATE)).toBe("idle");
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: 0, pid: process.pid, updated_at: 7 }));
    expect(readPlaybackState(STATE)).toBe("idle");
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: -1, pid: process.pid, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toBe("idle");
    writeFileSync(STATE, JSON.stringify(["speaking"]));
    expect(readPlaybackState(STATE)).toBe("idle");
  });

  test("speaking + live pid ⇒ speaking (injected and real default liveness)", () => {
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: 3, pid: 99999999, updated_at: "x" }));
    expect(readPlaybackState(STATE, () => true)).toBe("speaking");
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: 3, pid: process.pid, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toBe("speaking");
    expect(readPlaybackSignal(STATE).queue_depth).toBe(3);
  });

  test("speaking from a dead writer ⇒ idle (stale-crash guard)", () => {
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: 4, pid: process.pid, updated_at: "x" }));
    expect(readPlaybackState(STATE, () => false)).toBe("idle");
    expect(readPlaybackSignal(STATE, () => false)).toMatchObject({ state: "idle", queue_depth: 0 });
    writeFileSync(STATE, JSON.stringify({ state: "speaking", queue_depth: 4, pid: 2 ** 30, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toBe("idle");
  });

  test("idle state stays idle even with a live pid", () => {
    writeFileSync(STATE, JSON.stringify({ state: "idle", queue_depth: 0, pid: process.pid, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toBe("idle");
  });
});

describe("resolvePlaybackStatePath - env contract", () => {
  test("env-file override is honored and an empty live value disables publishing", () => {
    const saved = process.env.ECHO_PLAYBACK_STATE_PATH;
    try {
      delete process.env.ECHO_PLAYBACK_STATE_PATH;
      primeEchoFileEnv({ ECHO_PLAYBACK_STATE_PATH: "/from/file.json" }, false);
      expect(resolvePlaybackStatePath()).toBe("/from/file.json");
      process.env.ECHO_PLAYBACK_STATE_PATH = "";
      expect(resolvePlaybackStatePath()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ECHO_PLAYBACK_STATE_PATH;
      else process.env.ECHO_PLAYBACK_STATE_PATH = saved;
      primeEchoFileEnv(undefined);
    }
  });

  test("override is honored at call time; empty string disables; default is user-owned", () => {
    const saved = process.env.ECHO_PLAYBACK_STATE_PATH;
    try {
      primeEchoFileEnv({});
      process.env.ECHO_PLAYBACK_STATE_PATH = "/some/where.json";
      expect(resolvePlaybackStatePath()).toBe("/some/where.json");
      process.env.ECHO_PLAYBACK_STATE_PATH = "";
      expect(resolvePlaybackStatePath()).toBeNull();
      expect(readPlaybackState()).toBe("idle");
      expect(() => writePlaybackState({ state: "speaking", queue_depth: 1 })).not.toThrow();
      delete process.env.ECHO_PLAYBACK_STATE_PATH;
      expect(resolvePlaybackStatePath()).toContain(join(".local", "state", "echo", "playback-state.json"));
    } finally {
      process.env.ECHO_PLAYBACK_STATE_PATH = saved;
      primeEchoFileEnv(undefined);
    }
  });

  test("disabled path stays idle even when a file at another path would say speaking", () => {
    expect(readPlaybackState(null, () => true)).toBe("idle");
    expect(readPlaybackSignal(null).state).toBe("idle");
  });
});

// =============================================================================
// Play-queue seams - job start / settle / enqueue / drop
// =============================================================================

describe("PlayQueue publishes playback-state", () => {
  test("job start → speaking; settle → idle with depth 0", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const q = new PlayQueue<string>({
      player: async () => { await blocked; },
    });

    q.enqueue(job("a", "s1"));
    await waitFor(() => existsSync(STATE) && readFile(STATE).state === "speaking", 5000, "speaking");
    expect(readFile(STATE).queue_depth).toBe(0);
    expect(readFile(STATE).pid).toBe(process.pid);

    release();
    await q.drain();
    expect(readFile(STATE).state).toBe("idle");
    expect(readFile(STATE).queue_depth).toBe(0);
  });

  test("enqueue while speaking updates queue_depth", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "blocker") await blocked;
      },
    });

    q.enqueue(job("blocker", "s-block"));
    await waitFor(() => q.inFlightMs !== null && existsSync(STATE) && readFile(STATE).state === "speaking");
    q.enqueue(job("queued", "s1"));
    await waitFor(() => readFile(STATE).queue_depth === 1, 5000, "queued depth");
    expect(readFile(STATE).state).toBe("speaking");

    release();
    await q.drain();
    expect(readFile(STATE)).toMatchObject({ state: "idle", queue_depth: 0 });
  });

  test("depth-cap drop updates queue_depth", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "blocker") await blocked;
      },
      maxDepth: 1,
    });

    q.enqueue(job("blocker", "s-block"));
    await waitFor(() => q.depth === 0 && existsSync(STATE) && readFile(STATE).state === "speaking");
    q.enqueue(job("q1", "s1"));
    await waitFor(() => readFile(STATE).queue_depth === 1);
    q.enqueue(job("q2", "s2")); // drops q1
    expect(q.depth).toBe(1);
    expect(readFile(STATE).queue_depth).toBe(1);
    expect(readFile(STATE).state).toBe("speaking");

    release();
    await q.drain();
  });

  test("ECHO_PLAYBACK_STATE_PATH=\"\" disables further writes", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => { release = r; });
    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "blocker") await blocked;
      },
    });

    q.enqueue(job("blocker", "s-block"));
    await waitFor(() => existsSync(STATE) && readFile(STATE).state === "speaking");
    process.env.ECHO_PLAYBACK_STATE_PATH = "";
    q.enqueue(job("later", "s1"));
    await waitFor(() => q.depth === 1);
    expect(readFile(STATE).queue_depth).toBe(0); // freeze: disable skipped the enqueue write
    expect(readFile(STATE).state).toBe("speaking");

    release();
    await q.drain();
    expect(readFile(STATE).state).toBe("speaking"); // settle write also skipped
  });
});
