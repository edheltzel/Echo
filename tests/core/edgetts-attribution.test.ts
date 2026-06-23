// Issue #38 — behavioral proof of the #25 synth/playback failure-attribution
// rule for edge-tts. The existing guard (tests/core/server-contract-source.test.ts)
// is a STRUCTURAL source assertion: it can't catch a future edit that reintroduces
// a breaker call from the playback path under a different name. This test exercises
// EdgeTTSProvider.speak() for real and asserts the circuit-breaker STATE that
// results, so the attribution rule is verified by behavior, not by grep.
//
// The rule (core/circuit-breaker.ts header, issue #25):
//   • A SYNTHESIS failure is a provider failure → may open the edgetts breaker.
//   • A local PLAYBACK failure (afplay/mpv) is NOT a provider failure → must
//     never open the breaker.
//
// No production change is needed to test this: EdgeTTSProvider is reachable via
// the exported `providers.edgetts` singleton, and both edge-tts channels are
// subprocesses — so routing `node:child_process`.spawn through a swappable impl
// (the pattern from tests/core/egress-gating.test.ts) lets us drive synth and
// playback outcomes independently. speak() calls synthesizeOnce (python -m
// edge_tts) for synthesis and spawn(afplay|mpv) for playback; we classify the
// two by argv and feed each its own scripted outcome.
//
// Config is pinned via env BEFORE import so the breaker math is deterministic and
// independent of the host environment (these are module-load-time consts):
//   • PORT=0                      → ephemeral bind, never collides with :8888.
//   • THRESHOLD=2                 → two recorded failures open the breaker.
//   • SYNTH_RETRIES=1             → one retry, i.e. two synth attempts per speak().
//   • SYNTH_BACKOFF_MS=1          → retry sleep is ~1ms, keeps the suite fast.
//   • AUDIO_CACHE_DIR=<tmp>       → real createAudioTempFile() writes land in a
//                                   scratch dir, not the user's real cache.
process.env.PORT = "0";
process.env.VOICESYSTEM_CIRCUIT_BREAKER_THRESHOLD = "2";
process.env.VOICESYSTEM_EDGETTS_SYNTH_RETRIES = "1";
process.env.VOICESYSTEM_EDGETTS_SYNTH_BACKOFF_MS = "1";

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import * as realChildProcess from "node:child_process";
import { circuitBreakers, CIRCUIT_BREAKER_THRESHOLD } from "../../core/circuit-breaker.ts";

const AUDIO_SCRATCH = mkdtempSync(join(tmpdir(), "atlas-vs-edgetts-attr-"));
process.env.VOICESYSTEM_AUDIO_CACHE_DIR = AUDIO_SCRATCH;

// --- spawn seam (edge-tts synth + playback are both subprocesses) -----------
// Capture the real spawn, then route the module's `spawn` through a swappable
// impl so afterEach can restore it. Each child is fully stubbed — no python and
// no afplay/mpv ever runs. Outcomes are scripted per call by two behavior fns.
type SpawnOutcome = "success" | "fail-exit" | "error";
const realSpawn = realChildProcess.spawn;
let spawnImpl: (...args: any[]) => any = realSpawn;

let synthBehavior: () => SpawnOutcome = () => "success";
let playbackBehavior: () => SpawnOutcome = () => "success";
let synthSpawnCount = 0;
let playbackSpawnCount = 0;

// edge-tts synthesis spawns `python3 -m edge_tts ...`; playback spawns
// afplay/mpv. Anything that isn't a synth call is treated as playback.
function isSynthSpawn(command: string, args: string[]): boolean {
  return command.includes("python") || args.join(" ").includes("edge_tts");
}

function applyOutcome(child: EventEmitter, outcome: SpawnOutcome): void {
  // Settle asynchronously, after speak()/waitForProcess attach their listeners,
  // so the per-call timeout never fires.
  queueMicrotask(() => {
    if (outcome === "success") child.emit("exit", 0);
    else if (outcome === "fail-exit") child.emit("exit", 1);
    else child.emit("error", new Error("spawn failure (simulated)"));
  });
}

function controlledSpawn(command: unknown, args: unknown = []): any {
  const argv = Array.isArray(args) ? (args as string[]) : [];
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  child.pid = 4242;

  if (isSynthSpawn(String(command), argv)) {
    synthSpawnCount++;
    applyOutcome(child, synthBehavior());
  } else {
    playbackSpawnCount++;
    applyOutcome(child, playbackBehavior());
  }
  return child;
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: (realChildProcess as any).default ?? realChildProcess,
  spawn: (...args: any[]) => spawnImpl(...args),
}));

// Import AFTER the spawn mock + env are in place: the startup banner calls
// getProviderStatus() at module load, which probes edge-tts via spawn.
const { providers, voicesConfig, server } = await import("../../core/server.ts");

const edgetts = providers.edgetts;
const edgeBreaker = circuitBreakers.edgetts;

beforeEach(() => {
  spawnImpl = controlledSpawn;
  synthBehavior = () => "success";
  playbackBehavior = () => "success";
  synthSpawnCount = 0;
  playbackSpawnCount = 0;
  resetEdgeBreaker();
});

afterEach(() => {
  spawnImpl = realSpawn; // restore the real spawn binding between tests
  resetEdgeBreaker();
});

afterAll(() => {
  server?.stop?.();
  rmSync(AUDIO_SCRATCH, { recursive: true, force: true });
});

// The circuitBreakers map is a module singleton shared across the suite; reset
// the edgetts entry so each test starts from a closed breaker.
function resetEdgeBreaker(): void {
  edgeBreaker.failures = 0;
  edgeBreaker.lastFailure = 0;
  edgeBreaker.isOpen = false;
}

describe("issue #38 — edge-tts synth/playback failure attribution (circuit breaker state)", () => {
  test("config is pinned as the tests assume", () => {
    // Guards the rest of the file: if an env override changed the threshold, the
    // 'opens past threshold' test below would silently mean something else.
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(2);
  });

  test("synth fails once then succeeds (retry path) → breaker stays CLOSED", async () => {
    // First synth attempt fails, the retry succeeds; playback succeeds. A
    // transient blip that recovers on retry must NOT be recorded as a provider
    // failure, so the breaker stays closed and speak() reports success.
    let attempt = 0;
    synthBehavior = () => (attempt++ === 0 ? "fail-exit" : "success");
    playbackBehavior = () => "success";

    const ok = await edgetts.speak("hello world");

    expect(ok).toBe(true);
    expect(synthSpawnCount).toBe(2); // initial attempt + one retry
    expect(edgeBreaker.failures).toBe(0);
    expect(edgeBreaker.isOpen).toBe(false);
  });

  test("playback fails (synth succeeded) → breaker stays CLOSED (the #25 guarantee)", async () => {
    // Pre-load the breaker to one-below-threshold to make the assertion strict:
    // if a playback failure ever recorded a provider failure, that single call
    // would tip the breaker OPEN. The synth success resets failures to 0 first,
    // then the playback failure must leave it at 0 — proving playback is not
    // attributed to the provider.
    edgeBreaker.failures = CIRCUIT_BREAKER_THRESHOLD - 1;
    synthBehavior = () => "success";
    playbackBehavior = () => "fail-exit";

    const ok = await edgetts.speak("hello world");

    expect(ok).toBe(false); // playback failed → speak() reports failure
    expect(synthSpawnCount).toBe(1); // synth succeeded on the first attempt
    expect(playbackSpawnCount).toBe(1); // playback was actually attempted
    expect(edgeBreaker.failures).toBe(0); // success reset it; playback added nothing
    expect(edgeBreaker.isOpen).toBe(false);
  });

  test("playback ERROR (spawn error, synth succeeded) → breaker stays CLOSED", async () => {
    // Same guarantee via the spawn-error channel (afplay/mpv missing), not just
    // a non-zero exit, since waitForProcess rejects on both.
    edgeBreaker.failures = CIRCUIT_BREAKER_THRESHOLD - 1;
    synthBehavior = () => "success";
    playbackBehavior = () => "error";

    const ok = await edgetts.speak("hello world");

    expect(ok).toBe(false);
    expect(edgeBreaker.failures).toBe(0);
    expect(edgeBreaker.isOpen).toBe(false);
  });

  test("synth fails past threshold → breaker OPENS", async () => {
    // Every synth attempt (and retry) fails on every call → each speak() records
    // exactly one provider failure. After THRESHOLD failing calls the breaker
    // opens. This is the counterpart to the playback case: genuine synthesis
    // failures DO open the breaker.
    synthBehavior = () => "fail-exit";

    for (let i = 1; i <= CIRCUIT_BREAKER_THRESHOLD; i++) {
      const ok = await edgetts.speak("hello world");
      expect(ok).toBe(false);
      expect(edgeBreaker.failures).toBe(i); // one recorded failure per call
    }

    expect(edgeBreaker.failures).toBe(CIRCUIT_BREAKER_THRESHOLD);
    expect(edgeBreaker.isOpen).toBe(true);
    // Playback never runs when synthesis fails — nothing to attribute there.
    expect(playbackSpawnCount).toBe(0);
  });
});
