// Phase 1 / U2 — the daemon writes one audio-lifecycle event per spoken /notify,
// correlated by session_id, with the playback metrics the two playback sites
// deposit via AsyncLocalStorage.
//
// Pure derivation (classifyPlaybackOutcome / classifyPlaybackError /
// parseAfinfoDuration) is covered in audio-lifecycle-log.test.ts; this proves
// the end-to-end wiring: ALS capture → event write → session/request threading.
//
// Mirrors resolution-log.test.ts: PORT=0 for an ephemeral port, spawn stubbed so
// nothing shells out, ECHO_AUDIO_LIFECYCLE_LOG set before the first /notify (the
// daemon resolves the path at write time). afinfo (Bun.spawnSync) is not stubbed
// and runs against the empty stub temp file → clip_duration_s null, which is the
// documented best-effort degrade.
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realSpawn = realChildProcess.spawn;
let spawnImpl: (...args: any[]) => any = realSpawn;

function stubSpawn(): any {
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

const TMP = mkdtempSync(join(tmpdir(), "audio-lifecycle-srv-"));
const LOG = join(TMP, "audio-lifecycle.jsonl");
process.env.ECHO_AUDIO_LIFECYCLE_LOG = LOG;
process.env.ECHO_RESOLUTION_LOG ??= join(TMP, "resolution.jsonl");
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");
process.env.ECHO_MUTE_STATE_PATH ??= join(TMP, "mute.json");

const { server, voicesConfig } = await import("../../core/server.ts");
const PORT = (server as any).port;

let savedEnabled: Record<string, boolean>;

beforeEach(() => {
  spawnImpl = stubSpawn;
  savedEnabled = {};
  for (const name of Object.keys(voicesConfig.providers)) {
    savedEnabled[name] = (voicesConfig.providers as any)[name].enabled;
    (voicesConfig.providers as any)[name].enabled = false;
  }
  // Only edgetts (the user's active provider) — its stubbed synth + playback
  // both "succeed", so the row records a clean edgetts playback.
  (voicesConfig.providers as any).edgetts.enabled = true;
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

describe("audio-lifecycle event per /notify", () => {
  test("one row with session/request correlation and a completed playback", async () => {
    if (existsSync(LOG)) rmSync(LOG);
    const message = "a deliberately long spoken summary line for the lifecycle row";

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        voice_enabled: true,
        voice_id: "pi",
        session_id: "sess-abc",
      }),
    });
    expect(res.status).toBe(200);

    const lines = readFileSync(LOG, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const ev = JSON.parse(lines[0]);
    expect(ev.session_id).toBe("sess-abc");        // R3 correlation key
    expect(typeof ev.request_id).toBe("string");    // req-NNN threaded through
    expect(ev.provider).toBe("edgetts");
    expect(ev.message_chars).toBe(message.length);
    expect(ev.exit_reason).toBe("completed");        // stubbed afplay exits 0
    expect(ev.success).toBe(true);
    expect(ev.muted).toBe(false);
    expect(typeof ev.play_time_ms).toBe("number");   // measured wall-time present
    expect(() => new Date(ev.ts).toISOString()).not.toThrow();
  });

  test("muted /notify records a row with no playback and muted flag", async () => {
    if (existsSync(LOG)) rmSync(LOG);
    process.env.ECHO_MUTE_STATE_PATH = join(TMP, "mute-on.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.env.ECHO_MUTE_STATE_PATH, JSON.stringify({ muted: true, muted_until: null }));

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "muted turn", voice_enabled: true, session_id: "sess-mute" }),
    });
    expect(res.status).toBe(200);

    const lines = readFileSync(LOG, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.muted).toBe(true);
    expect(ev.success).toBe(false);
    expect(ev.play_time_ms).toBe(null);   // no playback happened
    expect(ev.exit_reason).toBe(null);

    process.env.ECHO_MUTE_STATE_PATH = join(TMP, "mute.json");
  });
});
