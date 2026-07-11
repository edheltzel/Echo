// Issue #83 — runtime mute: state module + speech-stage gate.
//
// Two layers:
//   1. core/mute.ts unit behavior: tolerant reads (missing/corrupt = unmuted,
//      never a crash), lazy expiry of timed mutes, atomic temp+rename writes.
//   2. The speech-stage gate: a muted daemon accepts /notify normally (identical
//      response shape), invokes ZERO providers (including macOS `say`), and the
//      resolution drop-off log still records the voice resolution tagged muted.
//
// PORT=0 binds an ephemeral port so importing the daemon never collides with a
// running :8888 instance. ECHO_MUTE_STATE_PATH is resolved at read/write time
// (not frozen at module load), so each test points it at its own temp file.
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Speak runs async behind the play queue (Phase 2 / R2): poll for the side
// effect each job produces, and always drain fully before the test returns.
import { waitFor as waitUntil } from "./poll";

// --- spawn stub -------------------------------------------------------------
// Every accepted /notify spawns osascript for the accept-time banner; the gate tests
// enable `say`, whose speak() also spawns. Every spawn is recorded so the muted
// path can assert zero provider invocations. Swappable impl restored in afterEach.
const realSpawn = realChildProcess.spawn;
let spawnedCommands: string[] = [];
let spawnImpl: (...args: any[]) => any = realSpawn;

function stubSpawn(cmd: string): any {
  spawnedCommands.push(cmd);
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

// --- temp paths -------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), "mute-"));
const MUTE_PATH = join(TMP, "mute.json");
const HTTP_LOG = join(TMP, "resolution.jsonl");
process.env.ECHO_MUTE_STATE_PATH = MUTE_PATH;
process.env.ECHO_RESOLUTION_LOG = HTTP_LOG;
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");

const { readMuteState, writeMuteState, setMuteState, toggleMuteState, resolveMuteStatePath } =
  await import("../../core/mute.ts");
const { server, voicesConfig } = await import("../../core/server.ts");
const PORT = (server as any).port;

let savedEnabled: Record<string, boolean>;

beforeEach(() => {
  spawnImpl = stubSpawn;
  spawnedCommands = [];
  if (existsSync(MUTE_PATH)) rmSync(MUTE_PATH);
  savedEnabled = {};
  for (const name of Object.keys(voicesConfig.providers)) {
    savedEnabled[name] = (voicesConfig.providers as any)[name].enabled;
    (voicesConfig.providers as any)[name].enabled = false;
  }
});

afterEach(() => {
  spawnImpl = realSpawn;
  for (const name of Object.keys(savedEnabled)) {
    (voicesConfig.providers as any)[name].enabled = savedEnabled[name];
  }
});

afterAll(() => {
  // Do NOT stop the shared singleton server (see the #47 flake note in
  // tests/core/resolution-log.test.ts). Removing TMP leaves
  // ECHO_MUTE_STATE_PATH pointing at a missing file = unmuted for sibling files.
  rmSync(TMP, { recursive: true, force: true });
});

// =============================================================================
// core/mute.ts — state module
// =============================================================================

describe("mute state — tolerant reads", () => {
  test("missing state file → unmuted default", () => {
    expect(readMuteState(join(TMP, "nope.json"))).toEqual({ muted: false, muted_until: null });
  });

  test("corrupt JSON → unmuted, no crash", () => {
    const p = join(TMP, "corrupt.json");
    writeFileSync(p, "{not json!!");
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null });
  });

  test("wrong shape (non-boolean muted) → unmuted, no crash", () => {
    const p = join(TMP, "shape.json");
    writeFileSync(p, JSON.stringify({ muted: "yes" }));
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null });
  });

  test("non-string muted_until (hand-edited numeric epoch) → unmuted, never indefinite mute", () => {
    const p = join(TMP, "numts.json");
    writeFileSync(p, JSON.stringify({ muted: true, muted_until: 12345 }));
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null });
  });

  test("unparseable muted_until timestamp → unmuted, no crash", () => {
    const p = join(TMP, "badts.json");
    writeFileSync(p, JSON.stringify({ muted: true, muted_until: "not-a-date" }));
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null });
  });
});

describe("mute state — set / toggle / lazy expiry", () => {
  test("indefinite mute persists with null deadline", () => {
    const p = join(TMP, "set.json");
    expect(setMuteState(true, undefined, p)).toEqual({ muted: true, muted_until: null });
    expect(readMuteState(p)).toEqual({ muted: true, muted_until: null });
  });

  test("timed mute records a deadline ≈ now + duration", () => {
    const p = join(TMP, "timed.json");
    const before = Date.now();
    const state = setMuteState(true, 30, p);
    const deadline = Date.parse(state.muted_until!);
    expect(deadline).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(readMuteState(p).muted).toBe(true);
  });

  test("muted_until in the past → unmuted (lazy expiry) and state cleaned up", () => {
    const p = join(TMP, "expired.json");
    writeMuteState({ muted: true, muted_until: new Date(Date.now() - 60_000).toISOString() }, p);
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null });
    // Opportunistic cleanup: the file on disk no longer claims muted.
    expect(JSON.parse(readFileSync(p, "utf-8")).muted).toBe(false);
  });

  test("muted_until in the future → still muted", () => {
    const p = join(TMP, "future.json");
    writeMuteState({ muted: true, muted_until: new Date(Date.now() + 60_000).toISOString() }, p);
    expect(readMuteState(p).muted).toBe(true);
  });

  test("unmute clears a timed deadline", () => {
    const p = join(TMP, "clear.json");
    setMuteState(true, 30, p);
    expect(setMuteState(false, undefined, p)).toEqual({ muted: false, muted_until: null });
    expect(readMuteState(p)).toEqual({ muted: false, muted_until: null });
  });

  test("toggle flips on then off", () => {
    const p = join(TMP, "toggle.json");
    expect(toggleMuteState(p).muted).toBe(true);
    expect(toggleMuteState(p).muted).toBe(false);
  });

  test("write is atomic: no temp-file leftovers, file always parses", () => {
    const p = join(TMP, "atomic", "mute.json");
    for (let i = 0; i < 20; i++) {
      writeMuteState({ muted: i % 2 === 0, muted_until: null }, p);
      expect(() => JSON.parse(readFileSync(p, "utf-8"))).not.toThrow();
    }
    const leftovers = readdirSync(join(TMP, "atomic")).filter(f => f !== "mute.json");
    expect(leftovers).toEqual([]);
  });

  test("ECHO_MUTE_STATE_PATH env override is honored", () => {
    expect(resolveMuteStatePath()).toBe(MUTE_PATH);
  });
});

// =============================================================================
// Speech-stage gate — /notify while muted
// =============================================================================

// Unique rate-limit bucket per request — the shared daemon caps 10/min per
// client IP, and the suite-wide 'localhost' bucket has no headroom to spare.
let bucket = 0;
async function postNotify(): Promise<Response> {
  return fetch(`http://localhost:${PORT}/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `mute-gate-test-${bucket++}` },
    body: JSON.stringify({ message: "mute gate test", voice_enabled: true, voice_id: "pi" }),
  });
}

function resolutionLines(): string[] {
  return existsSync(HTTP_LOG)
    ? readFileSync(HTTP_LOG, "utf-8").split("\n").filter(Boolean)
    : [];
}

describe("issue #83 — speech-stage mute gate", () => {
  test("unmuted (no state file) → say provider actually spawns", async () => {
    (voicesConfig.providers as any).say.enabled = true;

    const base = resolutionLines().length;
    const res = await postNotify();
    expect(res.status).toBe(202); // ack on receipt (Phase 2 / R2)
    await waitUntil(() => spawnedCommands.includes("/usr/bin/say"));
    // Full drain: the resolution row is written after the speak completes
    // (the banner now fires at ACCEPT, so it is no longer a drain marker).
    await waitUntil(() => resolutionLines().length > base);
  });

  test("muted → identical response shape, zero provider invocations, muted marker in drop-off log", async () => {
    (voicesConfig.providers as any).say.enabled = true;

    // Baseline: unmuted response. Wait for its job to drain so it cannot
    // bleed a spawn or log line into the muted half below.
    const baselineRows = resolutionLines().length;
    const unmutedRes = await postNotify();
    const unmutedBody = await unmutedRes.json();
    // Drain the baseline job fully (its resolution row lands after the speak;
    // the banner fires at accept and is not a drain marker) before resetting.
    await waitUntil(() => resolutionLines().length > baselineRows);

    // Mute, then notify again.
    writeMuteState({ muted: true, muted_until: null });
    if (existsSync(HTTP_LOG)) rmSync(HTTP_LOG);
    spawnedCommands = [];

    const res = await postNotify();
    const body = await res.json();

    // /notify contract shape-identical while muted (same status, keys, and
    // values — request_id is per-request by design).
    expect(res.status).toBe(unmutedRes.status);
    expect(Object.keys(body).sort()).toEqual(Object.keys(unmutedBody).sort());
    expect(body.status).toBe(unmutedBody.status);
    expect(body.message).toBe(unmutedBody.message);

    // The muted job drains: resolution row written; the accept-time banner
    // fired the moment the request was accepted.
    await waitUntil(() => resolutionLines().length === 1);
    await waitUntil(() => spawnedCommands.includes("/usr/bin/osascript"));

    // R1: zero provider invocations — no say, no audio player. The macOS
    // banner (osascript) is visual, not audio, and still fires (at accept).
    expect(spawnedCommands).not.toContain("/usr/bin/say");
    expect(spawnedCommands).not.toContain("/usr/bin/afplay");

    // R2: drop-off log still records the voice resolution, tagged muted.
    const lines = resolutionLines();
    expect(lines.length).toBe(1);
    const ev = JSON.parse(lines[0]);
    expect(ev.muted).toBe(true);
    expect(ev.requested_voice_id).toBe("pi");
    expect(ev.resolution).toBe("agent-key"); // resolution still recorded while muted
    expect(ev.provider).toBe("muted");
    expect(ev.attempts).toEqual([]);
  });

  test("expired timed mute → speaks again (lazy expiry at the gate)", async () => {
    (voicesConfig.providers as any).say.enabled = true;
    writeMuteState({ muted: true, muted_until: new Date(Date.now() - 1000).toISOString() });

    const base = resolutionLines().length;
    const res = await postNotify();
    expect(res.status).toBe(202);
    await waitUntil(() => spawnedCommands.includes("/usr/bin/say"));
    await waitUntil(() => resolutionLines().length > base); // full drain
  });

  test("future timed mute → suppressed", async () => {
    (voicesConfig.providers as any).say.enabled = true;
    writeMuteState({ muted: true, muted_until: new Date(Date.now() + 60_000).toISOString() });

    const base = resolutionLines().length;
    const res = await postNotify();
    expect(res.status).toBe(202);
    // Wait for the job to drain (its muted resolution row), THEN assert no speech.
    await waitUntil(() => resolutionLines().length > base);
    expect(spawnedCommands).not.toContain("/usr/bin/say");
  });

  test("corrupt state file → daemon speaks normally, never crashes", async () => {
    (voicesConfig.providers as any).say.enabled = true;
    writeFileSync(MUTE_PATH, "%%%corrupt%%%");

    const base = resolutionLines().length;
    const res = await postNotify();
    expect(res.status).toBe(202);
    await waitUntil(() => spawnedCommands.includes("/usr/bin/say"));
    await waitUntil(() => resolutionLines().length > base); // full drain
  });
});
