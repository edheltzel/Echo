// Audio lifecycle log (Phase 1 / U1) — the instrument that makes playback
// truncation measurable.
//
// Pure module: imports only core/audio-log.ts, so these tests never boot the
// server singleton (KTD2) — fast, and free of the #47 shared-server flake.
//
// Guarantees mirrored from the resolution-log design:
//   1. Exactly one parseable JSON line per write.
//   2. Rolling size-cap prune: never exceeds the cap, newest line always kept.
//   3. Best-effort: a write to an unwritable path never throws.
//   4. The default path honors ECHO_AUDIO_LIFECYCLE_LOG and creates the dir 0700.
// Plus the pure derivation helpers (classifyPlaybackOutcome / classifyPlaybackError
// / parseAfinfoDuration).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeAudioLifecycleEvent,
  classifyPlaybackOutcome,
  classifyPlaybackError,
  parseAfinfoDuration,
  type AudioLifecycleEvent,
} from "../../core/audio-log.ts";

const TMP = mkdtempSync(join(tmpdir(), "audio-log-"));
const savedEnv = process.env.ECHO_AUDIO_LIFECYCLE_LOG;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ECHO_AUDIO_LIFECYCLE_LOG;
  else process.env.ECHO_AUDIO_LIFECYCLE_LOG = savedEnv;
});

function eventFor(session: string): AudioLifecycleEvent {
  return {
    ts: "1970-01-01T00:00:00.000Z",
    session_id: session,
    request_id: `req-${session}`,
    message_chars: 42,
    provider: "edgetts",
    synth_duration_ms: 1200,
    clip_duration_s: 3.4,
    play_started_at: "1970-01-01T00:00:00.000Z",
    play_ended_at: "1970-01-01T00:00:03.400Z",
    play_time_ms: 3400,
    exit_reason: "completed",
    muted: false,
    success: true,
  };
}

describe("writeAudioLifecycleEvent — one event per write", () => {
  test("writes exactly one parseable JSON line with the expected fields", () => {
    const path = join(TMP, "one.jsonl");
    if (existsSync(path)) rmSync(path);

    writeAudioLifecycleEvent(eventFor("s1"), path, 1_000_000);

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.session_id).toBe("s1");
    expect(ev.request_id).toBe("req-s1");
    expect(ev.clip_duration_s).toBe(3.4);
    expect(ev.play_time_ms).toBe(3400);
    expect(ev.exit_reason).toBe("completed");
  });

  test("honors ECHO_AUDIO_LIFECYCLE_LOG and creates the dir without group/other access", () => {
    const dir = join(TMP, "nested", "Echo");
    const path = join(dir, "audio-lifecycle.jsonl");
    process.env.ECHO_AUDIO_LIFECYCLE_LOG = path;

    writeAudioLifecycleEvent(eventFor("env")); // default path resolves the env override

    expect(existsSync(path)).toBe(true);
    // Security property (KTD3 / R3): no group or other access on the created dir.
    expect(statSync(join(TMP, "nested", "Echo")).mode & 0o077).toBe(0);
  });

  test("a write to an unwritable path is swallowed — never throws", () => {
    // A path whose parent is a file, not a dir → mkdir/append fail internally.
    const filePath = join(TMP, "blocker");
    writeAudioLifecycleEvent(eventFor("x"), filePath, 1_000_000); // creates a file
    const underAFile = join(filePath, "nope.jsonl");
    expect(() => writeAudioLifecycleEvent(eventFor("y"), underAFile, 1_000_000)).not.toThrow();
  });
});

describe("writeAudioLifecycleEvent — rolling size-cap prune", () => {
  test("never exceeds the cap and keeps the newest lines", () => {
    const path = join(TMP, "prune.jsonl");
    if (existsSync(path)) rmSync(path);

    const CAP = 900;
    const N = 60;
    for (let i = 0; i < N; i++) {
      writeAudioLifecycleEvent(eventFor(String(i)), path, CAP);
      expect(statSync(path).size).toBeLessThanOrEqual(CAP);
    }

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const idx = lines.map((l: string) => Number(JSON.parse(l).session_id));
    expect(idx[idx.length - 1]).toBe(N - 1); // newest kept
    expect(idx[0]).toBeGreaterThan(0);        // oldest pruned
    for (let k = 1; k < idx.length; k++) expect(idx[k]).toBe(idx[k - 1] + 1);
  });

  test("a single line larger than the cap is still kept (newest never dropped)", () => {
    const path = join(TMP, "prune-big.jsonl");
    if (existsSync(path)) rmSync(path);
    writeAudioLifecycleEvent(eventFor("first"), path, 10);
    writeAudioLifecycleEvent(eventFor("second"), path, 10);
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).session_id).toBe("second");
  });
});

describe("classifyPlaybackOutcome — pure exit-reason derivation (KTD6)", () => {
  test("timed-out wins over everything", () => {
    expect(classifyPlaybackOutcome({ timedOut: true, errored: true, exitCode: 0 })).toBe("timed-out");
  });
  test("clean exit → completed", () => {
    expect(classifyPlaybackOutcome({ timedOut: false, errored: false, exitCode: 0 })).toBe("completed");
  });
  test("thrown error with no exit code → error", () => {
    expect(classifyPlaybackOutcome({ timedOut: false, errored: true, exitCode: null })).toBe("error");
  });
  test("non-zero exit → killed", () => {
    expect(classifyPlaybackOutcome({ timedOut: false, errored: false, exitCode: 1 })).toBe("killed");
  });
});

describe("classifyPlaybackError — parse waitForProcess rejections", () => {
  test("timeout message → timedOut", () => {
    expect(classifyPlaybackError("afplay timed out after 60000ms")).toEqual({ timedOut: true, exitCode: null, errored: false });
  });
  test("non-zero exit message → exitCode", () => {
    expect(classifyPlaybackError("afplay exited with code 137")).toEqual({ timedOut: false, exitCode: 137, errored: false });
  });
  test("unknown message → errored", () => {
    expect(classifyPlaybackError("spawn afplay ENOENT")).toEqual({ timedOut: false, exitCode: null, errored: true });
  });
});

describe("parseAfinfoDuration", () => {
  test("parses estimated duration in seconds", () => {
    expect(parseAfinfoDuration("File type ID:   MPG3\nestimated duration: 3.134 sec\n")).toBeCloseTo(3.134, 3);
  });
  test("missing line → null", () => {
    expect(parseAfinfoDuration("no duration here")).toBe(null);
  });
  test("unparseable value → null", () => {
    expect(parseAfinfoDuration("estimated duration: NaN sec")).toBe(null);
  });
});
