// Notification sounds: the dequeue gate that decides between speech and the
// notification's slot sound (request / done / generic).
//
// The daemon singleton runs on PORT=0. node:child_process is stubbed so no
// audio plays; every spawn's argv is recorded, which is how the tests see
// whether `say` (speech) or `afplay <slot file>` (a sound) ran.
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realSpawn = realChildProcess.spawn;
let spawns: string[][] = [];
let failingFiles = new Set<string>();
let spawnImpl: (...args: unknown[]) => unknown = realSpawn as (...args: unknown[]) => unknown;

function stubSpawn(cmd: string, args: string[] = []): EventEmitter {
  spawns.push([cmd, ...args]);
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write() {}, end() {} },
    kill() {},
    pid: 4242,
  });
  const fails = cmd === "/usr/bin/afplay" && args.some((arg) => failingFiles.has(arg));
  queueMicrotask(() => child.emit("exit", fails ? 1 : 0));
  return child;
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: "default" in realChildProcess ? realChildProcess.default : realChildProcess,
  spawn: (...args: unknown[]) => spawnImpl(...args),
}));

const TMP = mkdtempSync(join(tmpdir(), "slot-sound-"));
const MUTE_PATH = join(TMP, "mute.json");
const MODE_PATH = join(TMP, "mode.json");
process.env.ECHO_MUTE_STATE_PATH = MUTE_PATH;
process.env.ECHO_MODE_STATE_PATH = MODE_PATH;
process.env.ECHO_RESOLUTION_LOG = join(TMP, "resolution.jsonl");
process.env.ECHO_AUDIO_LIFECYCLE_LOG = join(TMP, "audio-lifecycle.jsonl");
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");

// Dynamic imports on purpose: the daemon reads these env paths at load, so it
// must load after they are set (static imports are hoisted above them).
const { writeMuteState } = await import("../../core/mute.ts");
const { writeOutputMode } = await import("../../core/output-mode.ts");
const { releaseCaptureReservationById } = await import("../../core/playback-reservation.ts");
const { server, voicesConfig, drainNotifications } = await import("../../core/server.ts");
const PORT = server.port;

const BUNDLED = join(import.meta.dir, "..", "..", "core", "sounds");
const SYSTEM = "/System/Library/Sounds";

let savedEnabled: Record<string, boolean>;
const providers = voicesConfig.providers as Record<string, { enabled: boolean }>;

beforeEach(() => {
  spawnImpl = stubSpawn as (...args: unknown[]) => unknown;
  spawns = [];
  failingFiles = new Set();
  for (const path of [MUTE_PATH, MODE_PATH]) if (existsSync(path)) rmSync(path);
  delete process.env.ECHO_SOUND_DONE;
  savedEnabled = {};
  for (const name of Object.keys(providers)) {
    savedEnabled[name] = providers[name].enabled;
    providers[name].enabled = name === "say";
  }
});

afterEach(() => {
  spawnImpl = realSpawn as (...args: unknown[]) => unknown;
  for (const name of Object.keys(savedEnabled)) providers[name].enabled = savedEnabled[name];
});

afterAll(() => {
  // Never stop the shared singleton server (#47).
  rmSync(TMP, { recursive: true, force: true });
});

let bucket = 0;
async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`http://localhost:${PORT}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `slot-sound-${bucket++}` },
    body: JSON.stringify(body),
  });
}

async function notify(extra: Record<string, unknown> = {}): Promise<Response> {
  const res = await post("/notify", { message: "slot sound test", voice_enabled: true, ...extra });
  await drainNotifications();
  return res;
}

const said = () => spawns.some(([cmd]) => cmd === "/usr/bin/say");
const played = () => spawns.filter(([cmd]) => cmd === "/usr/bin/afplay").map((argv) => argv[argv.length - 1]);

describe("slot field on /notify", () => {
  test("an unknown slot is a 400 and nothing is queued", async () => {
    const res = await notify({ slot: "loud" });
    expect(res.status).toBe(400);
    expect(said()).toBe(false);
    expect(played()).toEqual([]);
  });
});

describe("dequeue gate", () => {
  test("speech mode, unmuted, request: speaks and plays no sound", async () => {
    expect((await notify({ slot: "request" })).status).toBe(202);
    expect(said()).toBe(true);
    expect(played()).toEqual([]);
  });

  test("sounds mode, done: plays the bundled done sound and does not speak", async () => {
    writeOutputMode("sounds");
    await notify({ slot: "done" });
    expect(said()).toBe(false);
    expect(played()).toEqual([join(BUNDLED, "done.wav")]);
  });

  test("sounds mode, no slot: plays the generic sound", async () => {
    writeOutputMode("sounds");
    await notify();
    expect(played()).toEqual([join(BUNDLED, "generic.wav")]);
  });

  test("speech mode with tts mute, request: plays the request sound instead of speaking", async () => {
    writeMuteState({ muted: true, muted_until: null, scope: "tts" });
    await notify({ slot: "request" });
    expect(said()).toBe(false);
    expect(played()).toEqual([join(BUNDLED, "request.wav")]);
  });

  test("mute all, in either mode: nothing audible", async () => {
    writeMuteState({ muted: true, muted_until: null, scope: "all" });
    await notify({ slot: "done" });
    writeOutputMode("sounds");
    await notify({ slot: "done" });
    expect(said()).toBe(false);
    expect(played()).toEqual([]);
  });

  test("mic mute leaves sounds mode playing sounds", async () => {
    writeMuteState({ muted: false, muted_until: null, scope: "mic" });
    writeOutputMode("sounds");
    await notify({ slot: "done" });
    expect(played()).toEqual([join(BUNDLED, "done.wav")]);
  });

  test("voice_enabled false stays silent in sounds mode", async () => {
    writeOutputMode("sounds");
    await post("/notify", { message: "banner only", voice_enabled: false, slot: "done" });
    await drainNotifications();
    expect(said()).toBe(false);
    expect(played()).toEqual([]);
  });

  test("a configured slot file that is missing falls back to the system sound, not the bundled one", async () => {
    writeOutputMode("sounds");
    process.env.ECHO_SOUND_DONE = join(TMP, "gone.wav");
    failingFiles.add(join(TMP, "gone.wav"));
    await notify({ slot: "done" });
    expect(played()).toEqual([join(TMP, "gone.wav"), join(SYSTEM, "Hero.aiff")]);
  });

  test("a bundled file that fails to play falls back to the system sound", async () => {
    writeOutputMode("sounds");
    failingFiles.add(join(BUNDLED, "request.wav"));
    await notify({ slot: "request" });
    expect(played()).toEqual([join(BUNDLED, "request.wav"), join(SYSTEM, "Glass.aiff")]);
  });
});

describe("converse questions ignore the mode, not the mute", () => {
  const reservation = (id: string) => ({ reservation_id: id, owner_pid: process.pid, lease_ms: 30_000 });

  test("sounds mode: the question is spoken", async () => {
    writeOutputMode("sounds");
    await notify({ capture_reservation: reservation("slot-sound-ask-1") });
    releaseCaptureReservationById("slot-sound-ask-1");
    expect(said()).toBe(true);
    expect(played()).toEqual([]);
  });

  test("tts mute: the question is neither spoken nor turned into a sound", async () => {
    writeMuteState({ muted: true, muted_until: null, scope: "tts" });
    await notify({ capture_reservation: reservation("slot-sound-ask-2") });
    releaseCaptureReservationById("slot-sound-ask-2");
    expect(said()).toBe(false);
    expect(played()).toEqual([]);
  });
});

describe("replay", () => {
  test("a line played as a sound never enters the replay ring", async () => {
    await notify({ message: "spoken earlier" });
    writeOutputMode("sounds");
    await notify({ message: "only a ding" });
    spawns = [];
    await post("/replay", { n: 1 });
    await drainNotifications();
    expect(played()).toEqual([]);
    expect(said()).toBe(true);
  });

  test("sounds mode: replay speaks the line", async () => {
    await notify({ message: "say it again" });
    writeOutputMode("sounds");
    spawns = [];
    await post("/replay", { n: 1 });
    await drainNotifications();
    expect(said()).toBe(true);
    expect(played()).toEqual([]);
  });

  test("tts mute: replay is silent", async () => {
    await notify({ message: "quiet please" });
    writeMuteState({ muted: true, muted_until: null, scope: "tts" });
    spawns = [];
    await post("/replay", { n: 1 });
    await drainNotifications();
    expect(said()).toBe(false);
    expect(played()).toEqual([]);
  });

  test("a mode switch applies to a line already queued", async () => {
    const queued = post("/notify", { message: "queued first", voice_enabled: true, slot: "done" });
    writeOutputMode("sounds");
    await queued;
    await drainNotifications();
    expect(played()).toEqual([join(BUNDLED, "done.wav")]);
  });
});
