// Issue #24 — voice-resolution drop-off log.
//
// Two guarantees:
//   1. Exactly ONE structured resolution event is written per /notify, with the
//      expected fields (requested voice_id, how it resolved, provider+voice used,
//      per-provider attempts, fallback hops, success).
//   2. The file is size-capped: a rolling prune drops the oldest whole lines on
//      write so the file never exceeds the cap and always keeps the newest line.
//
// PORT=0 binds an ephemeral port so importing the daemon never collides with a
// running :8888 instance. ECHO_RESOLUTION_LOG is set before the first
// /notify; the daemon resolves the log path at write time (not frozen at module
// load), so this test reads its own temp file regardless of sibling import order.
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- spawn stub -------------------------------------------------------------
// sendNotification always spawns osascript for the macOS banner; with every
// provider disabled no provider subprocess runs, but the banner spawn must still
// be stubbed so the test never shells out. Swappable impl restored in afterEach.
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

// --- temp log path (captured by the daemon at import) -----------------------
const TMP = mkdtempSync(join(tmpdir(), "vrlog-"));
const HTTP_LOG = join(TMP, "http-resolution.jsonl");
process.env.ECHO_RESOLUTION_LOG = HTTP_LOG;
// The agent-key test drives a stubbed edgetts speak, which creates real temp
// dirs under AUDIO_CACHE_DIR (a module-load const) — point it at scratch. If a
// sibling file already imported the daemon its own scratch dir won, which is
// equally safe.
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");
// Pin the runtime-mute state (#83) away from the operator's real mute.json —
// a live muted state would suppress the `say`/edgetts positive controls here.
process.env.ECHO_MUTE_STATE_PATH ??= join(TMP, "mute.json");

const { server, voicesConfig, writeResolutionEvent } = await import("../../core/server.ts");
const PORT = (server as any).port;

const CONST_TS = "1970-01-01T00:00:00.000Z";
function eventFor(voice: string): any {
  return {
    ts: CONST_TS,
    requested_voice_id: voice,
    resolution: "agent-key",
    provider: "edgetts",
    voice: "en-US-AvaNeural",
    hops: 0,
    attempts: [{ provider: "edgetts", outcome: "success" }],
    success: true,
  };
}

let savedEnabled: Record<string, boolean>;

beforeEach(() => {
  spawnImpl = stubSpawn;
  // Disable every provider → the chain skips them all and returns a deterministic
  // failure (provider 'none', no spawn/fetch) so the logged event is stable.
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
  // Do NOT stop the shared singleton server here. `export const server` in
  // core/server.ts is created once and cached across every test file (Bun module
  // cache); stopping it from one file's afterAll tears it down for sibling files
  // whose tests then hit it — the source of the #47 flake (port 0 / connection
  // refused, nondeterministic with file order). The ephemeral PORT=0 server is
  // reclaimed when the `bun test` process exits.
  rmSync(TMP, { recursive: true, force: true });
});

describe("issue #24 — one resolution event per /notify", () => {
  test("POST /notify writes exactly one event with the expected fields", async () => {
    if (existsSync(HTTP_LOG)) rmSync(HTTP_LOG);

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "resolution drop-off test",
        voice_enabled: true,
        voice_id: "zzz-nope", // unresolved → fallback with a reason
      }),
    });
    expect(res.status).toBe(200);

    const lines = readFileSync(HTTP_LOG, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1); // exactly one event per /notify

    const ev = JSON.parse(lines[0]);
    expect(ev.requested_voice_id).toBe("zzz-nope");
    expect(ev.resolution).toBe("fallback");
    expect(ev.resolution_reason).toContain("zzz-nope");
    expect(ev.provider).toBe("none"); // all providers disabled
    expect(ev.voice).toBe(null);
    expect(ev.success).toBe(false);
    expect(Array.isArray(ev.attempts)).toBe(true);
    expect(ev.attempts.length).toBeGreaterThan(0);
    expect(ev.attempts.every((a: any) => a.outcome === "disabled")).toBe(true);
    expect(ev.hops).toBe(ev.attempts.length); // no provider succeeded → every hop counts
    expect(typeof ev.ts).toBe("string");
    expect(() => new Date(ev.ts).toISOString()).not.toThrow();
  });

  test("successful `say` fallback logs the real macOS voice, not null (P1)", async () => {
    if (existsSync(HTTP_LOG)) rmSync(HTTP_LOG);

    // edge-tts/elevenlabs/kokoro stay disabled (beforeEach); enable only `say`,
    // which always reports healthy and (with spawn stubbed) speaks successfully.
    (voicesConfig.providers as any).say.enabled = true;
    const expectedVoice = (voicesConfig.providers as any).say.voice || "Daniel (Enhanced)";

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "say fallback path", voice_enabled: true }),
    });
    expect(res.status).toBe(200);

    const lines = readFileSync(HTTP_LOG, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const ev = JSON.parse(lines[0]);
    expect(ev.provider).toBe("say");
    expect(ev.voice).toBe(expectedVoice); // the real fallback voice, not null
    expect(ev.voice).not.toBe(null);
    expect(ev.success).toBe(true);
    // edge-tts/elevenlabs/kokoro skipped (disabled), then say spoke → hops counts them.
    expect(ev.attempts[ev.attempts.length - 1]).toEqual({ provider: "say", outcome: "success" });
    expect(ev.hops).toBe(ev.attempts.length - 1);
  });

  test("voice_id 'pi' resolves as agent-key to en-GB-RyanNeural (#76, #81)", async () => {
    if (existsSync(HTTP_LOG)) rmSync(HTTP_LOG);

    // Enable only edgetts (the primary provider); the spawn stub makes its
    // health probe, synthesis, and playback all "succeed", so the event records
    // the voice the daemon actually resolved for the pi agent key — the
    // daemon-side half of the Pi adapter's default voice_id contract.
    (voicesConfig.providers as any).edgetts.enabled = true;

    const res = await fetch(`http://localhost:${PORT}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "pi persona resolution",
        voice_enabled: true,
        voice_id: "pi", // the Pi adapter's default (#76)
        source: "pi",
      }),
    });
    expect(res.status).toBe(200);

    const lines = readFileSync(HTTP_LOG, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const ev = JSON.parse(lines[0]);
    expect(ev.requested_voice_id).toBe("pi");
    expect(ev.resolution).toBe("agent-key");
    expect(ev.resolution_reason).toBeUndefined();
    expect(ev.provider).toBe("edgetts");
    expect(ev.voice).toBe("en-GB-RyanNeural"); // agents.pi.edgetts.voice (#81)
    expect(ev.success).toBe(true);
    expect(ev.attempts[0]).toEqual({ provider: "edgetts", outcome: "success" });
    expect(ev.hops).toBe(0); // primary provider spoke — no fallback hops
  });
});

describe("issue #24 — rolling size-cap prune", () => {
  test("never exceeds the cap and keeps the newest lines", () => {
    const path = join(TMP, "prune.jsonl");
    if (existsSync(path)) rmSync(path);

    const CAP = 700; // bytes — holds a few ~200-byte events
    const N = 60;
    for (let i = 0; i < N; i++) {
      writeResolutionEvent(eventFor(`voice-${i}`), path, CAP);
      // Invariant after every write: the file is back under the cap.
      expect(statSync(path).size).toBeLessThanOrEqual(CAP);
    }

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // Newest line is the last one written.
    const idx = lines.map((l: string) => Number(JSON.parse(l).requested_voice_id.split("-")[1]));
    expect(idx[idx.length - 1]).toBe(N - 1);
    // Kept lines are the newest contiguous block (oldest were pruned).
    expect(idx[0]).toBeGreaterThan(0);
    for (let k = 1; k < idx.length; k++) {
      expect(idx[k]).toBe(idx[k - 1] + 1);
    }
  });

  test("a single line larger than the cap is still kept (newest never dropped)", () => {
    const path = join(TMP, "prune-big.jsonl");
    if (existsSync(path)) rmSync(path);

    const CAP = 10; // smaller than one serialized event
    writeResolutionEvent(eventFor("first"), path, CAP);
    writeResolutionEvent(eventFor("second"), path, CAP);

    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).requested_voice_id).toBe("second");
  });
});
