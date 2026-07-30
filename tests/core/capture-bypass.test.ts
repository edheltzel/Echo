// F2: the capture owner speaking into its own hold, and the per-request playback
// completion signal that replaces polling /health.
//
// A voice ask must publish the microphone hold BEFORE it asks its question, or
// another session's audio can start in the gap between "question finished" and
// "microphone open". So the owner needs one narrow exception to the capture
// guard, and it is keyed on the secret in its own 0600 state file - never on the
// pid, which anyone who can stat the file could copy.
//
// The assertions below deliberately check whether the line REACHED THE PLAYER,
// not just what the state file said: a bypass that silently fails to speak is
// exactly the failure this exception exists to prevent, and a state-only test
// would pass while the question was inaudible.
//
// Harness mirrors capture-guard.test.ts: PORT=0, spawn stubbed, temp state
// paths, and it never stops the shared singleton server (AGENTS.md #47).
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCaptureRecord } from "../../core/capture-guard";

const realSpawn = realChildProcess.spawn;
let spawnImpl: (...args: any[]) => any = realSpawn;

function stubSpawn(command: string): any {
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

const TMP = mkdtempSync(join(tmpdir(), "capture-bypass-"));
const STATE = join(TMP, "recording-state.json");
process.env.ECHO_CAPTURE_STATE_PATH = STATE;
process.env.ECHO_MUTE_STATE_PATH = join(TMP, "mute.json");
process.env.ECHO_RESOLUTION_LOG ??= join(TMP, "resolution.jsonl");
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");

const { server, voicesConfig, speakWithFallback, drainNotifications } = await import("../../core/server.ts");
const PORT = (server as any).port;

const NONCE = "owner-secret-abc123";

function writeCapture(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    STATE,
    JSON.stringify({ state: "recording", pid: process.pid, updated_at: new Date().toISOString(), ...overrides }),
  );
}

let savedEnabled: Record<string, boolean>;
let bucket = 0;
let HEADERS: Record<string, string>;

beforeEach(() => {
  spawnImpl = stubSpawn;
  // Every provider disabled: a call that gets PAST the capture guard still
  // records one attempt per provider, which is the observable "it reached the
  // provider loop" signal without synthesizing or playing anything.
  savedEnabled = {};
  for (const name of Object.keys(voicesConfig.providers)) {
    savedEnabled[name] = (voicesConfig.providers as any)[name].enabled;
    (voicesConfig.providers as any)[name].enabled = false;
  }
  if (existsSync(STATE)) rmSync(STATE);
  process.env.ECHO_CAPTURE_STATE_PATH = STATE;
  HEADERS = { "Content-Type": "application/json", "x-forwarded-for": `capture-bypass-test-${bucket++}` };
});

afterEach(() => {
  spawnImpl = realSpawn;
  for (const name of Object.keys(savedEnabled)) {
    (voicesConfig.providers as any)[name].enabled = savedEnabled[name];
  }
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("the capture owner may speak into its own hold", () => {
  test("a matching nonce reaches the provider loop instead of being held", async () => {
    writeCapture({ nonce: NONCE });

    const result = await speakWithFallback("the question", undefined, null, undefined, NONCE);

    // Reaching the providers is the audible path: the guard did not hold it.
    expect(result.held_for_capture).toBeUndefined();
    expect(result.attempts.length).toBeGreaterThan(0);
  });

  test("no nonce on the request is held, exactly as before", async () => {
    writeCapture({ nonce: NONCE });

    const result = await speakWithFallback("an unrelated notification");

    expect(result.held_for_capture).toBe(true);
    expect(result.provider).toBe("capture-held");
    expect(result.attempts).toEqual([]);
  });

  test("a wrong nonce is held, not rejected", async () => {
    // A mismatch must degrade to the ordinary hold. Turning it into an error
    // would give a local process a way to make notifications fail.
    writeCapture({ nonce: NONCE });

    const result = await speakWithFallback("someone else's line", undefined, null, undefined, "guessed-wrong");

    expect(result.held_for_capture).toBe(true);
    expect(result.attempts).toEqual([]);
  });

  test("a capture published without a nonce cannot be bypassed at all", async () => {
    // VoiceLayer's VoiceBar writes no nonce. Its recordings stay protected even
    // from a caller that presents one.
    writeCapture();

    const result = await speakWithFallback("the question", undefined, null, undefined, NONCE);

    expect(result.held_for_capture).toBe(true);
  });

  test("an empty nonce in the file is not a bypass credential", async () => {
    writeCapture({ nonce: "" });

    const result = await speakWithFallback("the question", undefined, null, undefined, "");

    expect(result.held_for_capture).toBe(true);
  });

  test("a dead capture owner holds nothing, with or without a nonce", async () => {
    writeCapture({ nonce: NONCE, pid: 999_999_999 });

    const result = await speakWithFallback("an ordinary line");

    expect(result.held_for_capture).toBeUndefined();
    expect(readCaptureRecord(STATE)).toBeNull();
  });

  test("the nonce is never exposed through /health", async () => {
    writeCapture({ nonce: NONCE });

    const health = await (await fetch(`http://localhost:${PORT}/health`, { headers: HEADERS })).json();

    expect(health.capture_guard.pid).toBe(process.pid);
    expect(JSON.stringify(health)).not.toContain(NONCE);
  });
});

describe("await_playback: a per-request completion signal", () => {
  test("holds the response until the line reaches a terminal disposition", async () => {
    writeCapture({ nonce: NONCE });

    const response = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        message: "Shall I continue?",
        voice_enabled: true,
        session_id: "converse:t-1",
        capture_bypass_nonce: NONCE,
        await_playback: true,
      }),
    });
    const body = await response.json();

    // 200 with a disposition, not 202 on receipt: by the time this resolves the
    // line is finished, which is what lets a caller open a microphone next.
    expect(response.status).toBe(200);
    expect(body.disposition).toBe("played");
    expect(body.request_id).toBeTruthy();
  });

  test("a caller that does not ask still gets 202 on receipt", async () => {
    const response = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "ordinary notification", voice_enabled: true }),
    });

    expect(response.status).toBe(202);
    expect((await response.json()).status).toBe("accepted");
    await drainNotifications();
  });

  test("a banner-only notification reports that nothing was queued", async () => {
    const response = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "silent", voice_enabled: false, await_playback: true }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.disposition).toBe("not_queued");
  });

  test("a line the guard held is reported as held, never as played", async () => {
    // This is the distinction the whole interlock rests on. A held line still
    // reaches the player, so a naive "the job finished" signal would say
    // "played" and a voice ask would open its microphone on a question nobody
    // heard - exactly the failure F2 describes.
    writeCapture({ nonce: NONCE });

    const response = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        message: "held by the guard",
        voice_enabled: true,
        session_id: "other-session",
        await_playback: true,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.disposition).toBe("held");
    expect(body.status).toBe("not_played");
  });

  test("a muted daemon is reported as muted, never as played", async () => {
    const muteState = join(TMP, "mute.json");
    writeFileSync(muteState, JSON.stringify({ muted: true, muted_until: null }));
    process.env.ECHO_MUTE_STATE_PATH = muteState;
    try {
      const response = await fetch(`http://localhost:${PORT}/notify`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ message: "silenced", voice_enabled: true, await_playback: true }),
      });
      const body = await response.json();

      expect(body.disposition).toBe("muted");
      expect(body.status).toBe("not_played");
    } finally {
      rmSync(muteState, { force: true });
    }
  });
});
