// Capture guard — hold Echo speech while an external tool captures the mic.
// Unit half: tolerant reads of the cross-process recording-state file
// (missing/corrupt/wrong shape ⇒ idle) and pid-liveness (a crashed writer's
// stale non-idle file must never silence Echo). Gate half: through the real
// server — a live capture skips the voice line mute-style (no player spawn,
// lifecycle row disposition 'held-for-capture'), an idle file speaks normally,
// and /health exposes the guard. Harness mirrors notify-queue.test.ts:
// PORT=0, spawn stubbed, temp state paths, never stops the singleton (#47).
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptureState, isCaptureActive, resolveCaptureStatePath } from "../../core/capture-guard";
import { primeEchoFileEnv } from "../../core/env";
import { waitFor } from "./poll";

// --- spawn stub (playback is platform-dependent: afplay on darwin, mpv else) -
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
  queueMicrotask(() => child.emit("exit", 0));
  return child;
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: (realChildProcess as any).default ?? realChildProcess,
  spawn: (...args: any[]) => spawnImpl(...args),
}));

const TMP = mkdtempSync(join(tmpdir(), "capture-guard-"));
const STATE = join(TMP, "recording-state.json");
const LOG = join(TMP, "audio-lifecycle.jsonl");
process.env.ECHO_CAPTURE_STATE_PATH = STATE;
process.env.ECHO_AUDIO_LIFECYCLE_LOG = LOG;
process.env.ECHO_RESOLUTION_LOG ??= join(TMP, "resolution.jsonl");
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");
process.env.ECHO_MUTE_STATE_PATH = join(TMP, "mute.json");

const { server, voicesConfig, drainNotifications } = await import("../../core/server.ts");
const PORT = (server as any).port;

function writeState(state: string, pid: number = process.pid): void {
  writeFileSync(STATE, JSON.stringify({ state, pid, updated_at: new Date().toISOString() }));
}

// =============================================================================
// Unit — tolerant reads + pid liveness (no server involved)
// =============================================================================

describe("readCaptureState — tolerant reads", () => {
  const U = mkdtempSync(join(tmpdir(), "capture-unit-"));
  const uPath = join(U, "recording-state.json");
  afterAll(() => rmSync(U, { recursive: true, force: true }));

  test("missing file ⇒ idle / inactive", () => {
    expect(readCaptureState(join(U, "nope.json"))).toBe("idle");
    expect(isCaptureActive(join(U, "nope.json"))).toBe(false);
  });

  test("corrupt JSON ⇒ idle, never a throw", () => {
    writeFileSync(uPath, "{not json");
    expect(readCaptureState(uPath)).toBe("idle");
  });

  test("wrong shape ⇒ idle (bad state / non-number pid / non-string updated_at)", () => {
    writeFileSync(uPath, JSON.stringify({ state: "listening", pid: process.pid, updated_at: "x" }));
    expect(readCaptureState(uPath)).toBe("idle");
    writeFileSync(uPath, JSON.stringify({ state: "recording", pid: "4242", updated_at: "x" }));
    expect(readCaptureState(uPath)).toBe("idle");
    writeFileSync(uPath, JSON.stringify({ state: "recording", pid: process.pid, updated_at: 7 }));
    expect(readCaptureState(uPath)).toBe("idle");
    writeFileSync(uPath, JSON.stringify(["recording"]));
    expect(readCaptureState(uPath)).toBe("idle");
  });

  test("recording + live pid ⇒ active (injected and real default liveness)", () => {
    writeFileSync(uPath, JSON.stringify({ state: "recording", pid: 99999999, updated_at: "x" }));
    expect(readCaptureState(uPath, () => true)).toBe("recording");
    // Default liveness against a pid that is certainly alive: our own.
    writeFileSync(uPath, JSON.stringify({ state: "recording", pid: process.pid, updated_at: "x" }));
    expect(readCaptureState(uPath)).toBe("recording");
    expect(isCaptureActive(uPath)).toBe(true);
  });

  test("non-idle from a dead writer ⇒ idle (stale-crash guard)", () => {
    writeFileSync(uPath, JSON.stringify({ state: "recording", pid: process.pid, updated_at: "x" }));
    expect(readCaptureState(uPath, () => false)).toBe("idle");
  });

  test("transcribing + live pid ⇒ active; idle state ⇒ inactive", () => {
    writeFileSync(uPath, JSON.stringify({ state: "transcribing", pid: process.pid, updated_at: "x" }));
    expect(readCaptureState(uPath)).toBe("transcribing");
    writeFileSync(uPath, JSON.stringify({ state: "idle", pid: process.pid, updated_at: "x" }));
    expect(isCaptureActive(uPath)).toBe(false);
  });
});

describe("resolveCaptureStatePath — env contract", () => {
  test("env-file override is honored and an empty live value disables the guard", () => {
    const saved = process.env.ECHO_CAPTURE_STATE_PATH;
    try {
      delete process.env.ECHO_CAPTURE_STATE_PATH;
      primeEchoFileEnv({ ECHO_CAPTURE_STATE_PATH: "/from/file.json" });
      expect(resolveCaptureStatePath()).toBe("/from/file.json");
      process.env.ECHO_CAPTURE_STATE_PATH = "";
      expect(resolveCaptureStatePath()).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.ECHO_CAPTURE_STATE_PATH;
      else process.env.ECHO_CAPTURE_STATE_PATH = saved;
      primeEchoFileEnv(undefined);
    }
  });

  test("override is honored at call time; empty string disables the guard", () => {
    const saved = process.env.ECHO_CAPTURE_STATE_PATH;
    try {
      process.env.ECHO_CAPTURE_STATE_PATH = "/some/where.json";
      expect(resolveCaptureStatePath()).toBe("/some/where.json");
      process.env.ECHO_CAPTURE_STATE_PATH = "";
      expect(resolveCaptureStatePath()).toBeNull();
      expect(readCaptureState()).toBe("idle"); // disabled ⇒ idle regardless
      delete process.env.ECHO_CAPTURE_STATE_PATH;
      expect(resolveCaptureStatePath()).toContain(join(".local", "state", "voicelayer", "recording-state.json"));
    } finally {
      process.env.ECHO_CAPTURE_STATE_PATH = saved;
    }
  });

  test("disabled guard ('') stays idle even when the default-path file would say recording", () => {
    // A null path short-circuits before any filesystem read.
    expect(readCaptureState(null, () => true)).toBe("idle");
    expect(isCaptureActive(null)).toBe(false);
  });
});

// =============================================================================
// Gate — through the real server (mirrors the mute gate's shape)
// =============================================================================

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
  if (existsSync(STATE)) rmSync(STATE);
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `capture-guard-test-${bucket++}` };
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

describe("capture guard — speak-time gate", () => {
  test("live capture: 202, banner fires, no player spawn, lifecycle row held-for-capture", async () => {
    writeState("recording");

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "held line", voice_enabled: true, session_id: "sess-held" }),
    });
    expect(res.status).toBe(202);
    await drainNotifications();

    // Banner is not audio: it fired at accept. No playback binary ran.
    await waitFor(() => spawnedCommands.includes("/usr/bin/osascript"));
    expect(spawnedCommands.filter((c) => /afplay|mpv/.test(c))).toEqual([]);

    await waitFor(() => readRows().length >= 1);
    const row = readRows()[0];
    expect(row.session_id).toBe("sess-held");
    expect(row.provider).toBe("capture-held");
    expect(row.disposition).toBe("held-for-capture");
    expect(row.success).toBe(false);
    expect(row.play_time_ms).toBe(null);
  });

  test("idle file (and dead-writer stale file): speech resumes", async () => {
    // Stale non-idle file from a pid that cannot be alive.
    writeFileSync(STATE, JSON.stringify({ state: "recording", pid: 2 ** 30, updated_at: new Date().toISOString() }));

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "spoken line", voice_enabled: true, session_id: "sess-spoken" }),
    });
    expect(res.status).toBe(202);
    await drainNotifications();

    await waitFor(() => readRows().length >= 1);
    const row = readRows()[0];
    expect(row.disposition).toBe("played");
    expect(row.provider).toBe("edgetts");
    expect(spawnedCommands.some((c) => /afplay|mpv/.test(c))).toBe(true);
  });

  test("/health exposes the guard's resolved path and current state", async () => {
    writeState("transcribing");
    const health = await (await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS })).json();
    expect(health.capture_guard).toEqual({ path: STATE, state: "transcribing" });

    rmSync(STATE);
    const idle = await (await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS })).json();
    expect(idle.capture_guard).toEqual({ path: STATE, state: "idle" });
  });
});
