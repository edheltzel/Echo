// Phase 1 / U3 — hook voice-event logging.
//
// Two guarantees:
//   R2 — a client abort after POST is labeled 'aborted', not 'failed' (the
//        daemon received the request and plays independently).
//   R3 — events write to ~/.agents/Echo/ (env-overridable), dir created without
//        group/other access, correlatable with the daemon log by session_id.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isAbortError,
  resolveVoiceEventsLogPath,
  logVoiceEvent,
} from "../../../adapters/claudecode/hooks/handlers/VoiceNotification.ts";

const TMP = mkdtempSync(join(tmpdir(), "voice-events-"));
const savedEnv = process.env.ECHO_VOICE_EVENTS_LOG;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ECHO_VOICE_EVENTS_LOG;
  else process.env.ECHO_VOICE_EVENTS_LOG = savedEnv;
});

describe("isAbortError (R2) — abort vs. genuine failure", () => {
  test("an AbortController abort is recognized", () => {
    const err = new Error("The operation was aborted.");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });
  test("a real network/HTTP error is not an abort", () => {
    expect(isAbortError(new Error("fetch failed"))).toBe(false);
  });
  test("a non-Error value is not an abort", () => {
    expect(isAbortError("nope")).toBe(false);
  });
});

describe("resolveVoiceEventsLogPath (R3)", () => {
  test("defaults under ~/.agents/Echo", () => {
    delete process.env.ECHO_VOICE_EVENTS_LOG;
    expect(resolveVoiceEventsLogPath()).toContain(join(".agents", "Echo", "voice-events.jsonl"));
  });
  test("honors ECHO_VOICE_EVENTS_LOG", () => {
    process.env.ECHO_VOICE_EVENTS_LOG = "/somewhere/custom.jsonl";
    expect(resolveVoiceEventsLogPath()).toBe("/somewhere/custom.jsonl");
  });
});

describe("logVoiceEvent (R2, R3)", () => {
  test("writes one parseable line; 'aborted' is distinct from 'failed'; dir has no group/other access", () => {
    const dir = join(TMP, "Echo");
    const path = join(dir, "voice-events.jsonl");
    process.env.ECHO_VOICE_EVENTS_LOG = path;

    logVoiceEvent({
      timestamp: "1970-01-01T00:00:00.000Z",
      session_id: "s-abort",
      event_type: "aborted",
      message: "long summary that played past the 12s client wait",
      character_count: 48,
      voice_engine: "elevenlabs",
      voice_id: "",
      error: "The operation was aborted.",
    });

    expect(existsSync(path)).toBe(true);
    expect(statSync(dir).mode & 0o077).toBe(0); // 0700 dir

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.event_type).toBe("aborted");
    expect(ev.event_type).not.toBe("failed");
    expect(ev.session_id).toBe("s-abort");
  });
});
