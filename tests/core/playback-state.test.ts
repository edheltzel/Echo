// Playback signal file: atomic write, play-queue speaking/idle transitions,
// disabled path writes nothing, a failed write never throws. Scratch paths
// only. Does not import the daemon (no server.stop).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlayQueue, type PlayJob } from "../../core/play-queue";
import { primeEchoFileEnv } from "../../core/env";
import {
  readPlaybackState,
  resolvePlaybackStatePath,
  writePlaybackState,
} from "../../core/playback-state";
import { waitFor } from "./poll";

const TMP = mkdtempSync(join(tmpdir(), "playback-state-"));
const STATE = join(TMP, "playback-state.json");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function job(id: string, sessionId: string | null = null): PlayJob<string> {
  return { id, sessionId, receivedAt: Date.now(), payload: id };
}

async function withPlaybackEnv<T>(value: string | undefined, body: () => T | Promise<T>): Promise<T> {
  const saved = process.env.ECHO_PLAYBACK_STATE_PATH;
  try {
    if (value === undefined) delete process.env.ECHO_PLAYBACK_STATE_PATH;
    else process.env.ECHO_PLAYBACK_STATE_PATH = value;
    return await body();
  } finally {
    if (saved === undefined) delete process.env.ECHO_PLAYBACK_STATE_PATH;
    else process.env.ECHO_PLAYBACK_STATE_PATH = saved;
  }
}

describe("writePlaybackState", () => {
  test("atomic write replaces a complete record and leaves no temp", () => {
    const now = Date.parse("2026-07-13T00:00:00.000Z");
    writePlaybackState("speaking", 2, STATE, 4242, now);
    expect(JSON.parse(readFileSync(STATE, "utf8"))).toEqual({
      state: "speaking",
      queue_depth: 2,
      pid: 4242,
      updated_at: "2026-07-13T00:00:00.000Z",
    });
    expect(readdirSync(TMP).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(statSync(STATE).mode & 0o777).toBe(0o600);

    writePlaybackState("idle", 0, STATE, 4242, now);
    expect(JSON.parse(readFileSync(STATE, "utf8")).state).toBe("idle");
    expect(readdirSync(TMP).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("write failure does not throw and leaves no temp", () => {
    const blocker = join(TMP, "blocker");
    writeFileSync(blocker, "not a directory");
    expect(() => writePlaybackState("speaking", 1, join(blocker, "playback-state.json"), 4242)).not.toThrow();

    const dest = join(TMP, "dest-is-dir");
    mkdirSync(dest);
    expect(() => writePlaybackState("speaking", 1, dest, 4242)).not.toThrow();
    expect(readdirSync(TMP).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a planted file at a staging-like name is never reopened", () => {
    const dir = mkdtempSync(join(TMP, "planted-"));
    const legacyStaging = join(dir, ".4242.playback-state.tmp");
    expect(Bun.spawnSync(["mkfifo", legacyStaging]).exitCode).toBe(0);
    const dest = join(dir, "playback-state.json");
    writePlaybackState("speaking", 2, dest, 4242);
    expect(JSON.parse(readFileSync(dest, "utf-8")).queue_depth).toBe(2);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
  });
});

describe("readPlaybackState - tolerant reads", () => {
  test("missing or corrupt file reads as idle", () => {
    expect(readPlaybackState(join(TMP, "missing.json"))).toEqual({ state: "idle", queue_depth: 0 });
    writeFileSync(STATE, "{not json");
    expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 0 });
  });

  test("wrong shape reads as idle", () => {
    writeFileSync(STATE, JSON.stringify({ state: "listening", pid: 1, queue_depth: 0, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 0 });
    writeFileSync(STATE, JSON.stringify({ state: "speaking", pid: "1", queue_depth: 0, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 0 });
    writeFileSync(STATE, JSON.stringify({ state: "speaking", pid: 1, queue_depth: -1, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 0 });
    // pid 0 would probe this process group, not a daemon.
    writeFileSync(STATE, JSON.stringify({ state: "speaking", pid: 0, queue_depth: 3, updated_at: "x" }));
    expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 0 });
  });

  test("speaking plus a live pid is speaking; a dead pid reads as idle", () => {
    writeFileSync(STATE, JSON.stringify({
      state: "speaking", pid: 99999999, queue_depth: 3, updated_at: "x",
    }));
    expect(readPlaybackState(STATE, () => true)).toEqual({ state: "speaking", queue_depth: 3 });
    expect(readPlaybackState(STATE, () => false)).toEqual({ state: "idle", queue_depth: 0 });

    writeFileSync(STATE, JSON.stringify({
      state: "speaking", pid: process.pid, queue_depth: 1, updated_at: "x",
    }));
    expect(readPlaybackState(STATE)).toEqual({ state: "speaking", queue_depth: 1 });
  });

  test("idle from a live pid keeps queue_depth; a dead pid still reads as idle", () => {
    writeFileSync(STATE, JSON.stringify({
      state: "idle", pid: process.pid, queue_depth: 4, updated_at: "x",
    }));
    expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 4 });
    expect(readPlaybackState(STATE, () => false)).toEqual({ state: "idle", queue_depth: 0 });
  });
});

describe("resolvePlaybackStatePath", () => {
  test("unset is the published ~/.local/state path and ignores XDG_STATE_HOME", async () => {
    const savedXdg = process.env.XDG_STATE_HOME;
    try {
      primeEchoFileEnv({});
      process.env.XDG_STATE_HOME = join(TMP, "xdg-state");
      await withPlaybackEnv(undefined, () => {
        expect(resolvePlaybackStatePath()).toMatch(/\/\.local\/state\/echo\/playback-state\.json$/);
      });
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = savedXdg;
      primeEchoFileEnv(undefined);
    }
  });

  test("override is honored at call time; empty string disables", async () => {
    await withPlaybackEnv(STATE, () => expect(resolvePlaybackStatePath()).toBe(STATE));
    await withPlaybackEnv("", () => {
      expect(resolvePlaybackStatePath()).toBeNull();
      expect(readPlaybackState()).toEqual({ state: "idle", queue_depth: 0 });
    });
  });
});

describe("play-queue seams", () => {
  test("job start writes speaking, enqueue refreshes depth, settle writes idle", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    await withPlaybackEnv(STATE, async () => {
      rmSync(STATE, { force: true });
      const q = new PlayQueue<string>({
        player: async (j) => {
          if (j.id === "a") await blocked;
        },
        maxDepth: 1,
      });

      q.enqueue(job("a", "s1"));
      await waitFor(() => readPlaybackState(STATE).state === "speaking");
      expect(readPlaybackState(STATE)).toEqual({ state: "speaking", queue_depth: 0 });

      q.enqueue(job("b", "s2"));
      expect(q.depth).toBe(1);
      expect(readPlaybackState(STATE)).toEqual({ state: "speaking", queue_depth: 1 });

      q.enqueue(job("c", "s3"));
      expect(q.depth).toBe(1);
      expect(readPlaybackState(STATE)).toEqual({ state: "speaking", queue_depth: 1 });

      release();
      await q.drain();
      expect(readPlaybackState(STATE)).toEqual({ state: "idle", queue_depth: 0 });
    });
  });
});
