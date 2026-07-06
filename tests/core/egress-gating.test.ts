// Issue #26 — prove the egress-gating guarantee at runtime: a DISABLED provider
// never makes an outbound call (no synthesis, no auth/health probe), across both
// the speakWithFallback chain and the /health (getProviderStatus) path.
//
// Two egress channels are spied, because the providers use two:
//   • fetch  — ElevenLabs + Kokoro (HTTP)
//   • spawn  — edge-tts (spawn(python3 -m edge_tts ...)); fetch can't see this.
// Each spy asserts zero traffic for a disabled provider and live traffic once
// the provider is enabled (positive controls prove the spy works and that
// `enabled` is the only gate).
//
// PORT=0 binds an ephemeral port so importing the daemon never collides with a
// running :8888 instance. The shared singleton server is intentionally not stopped
// here — it's cached across test files and stopping it would break siblings that
// fetch it (see resolution-log.test.ts / #47); the process exit reclaims the port.
process.env.PORT = "0";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { circuitBreakers } from "../../core/circuit-breaker.ts";

// Pin the runtime-mute state (#83) away from the operator's real mute.json —
// speakWithFallback reads it on every call, and a live muted state would make
// the positive-control assertions below fail nondeterministically.
process.env.ECHO_MUTE_STATE_PATH ??= join(mkdtempSync(join(tmpdir(), "egress-mute-")), "mute.json");

// --- spawn spy (edge-tts egresses via spawn, not fetch) ---------------------
// Capture the real spawn before mocking, then route the module's `spawn` through
// a swappable impl so afterEach can restore the real binding. The recording impl
// stubs the child entirely — the real python/edge_tts subprocess never runs.
const realSpawn = realChildProcess.spawn;
let spawnCalls: Array<{ command: string; args: string[] }> = [];
let spawnImpl: (...args: any[]) => any = realSpawn;

function recordingSpawn(command: string, args: unknown = []): any {
  const argv = Array.isArray(args) ? (args as string[]) : [];
  spawnCalls.push({ command: String(command), args: argv });
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = () => {};
  child.pid = 4242;
  // Resolve the caller's `.on('exit', ...)` promise with success, asynchronously
  // (after the handler is attached), without launching a real process.
  queueMicrotask(() => child.emit("exit", 0));
  return child;
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: (realChildProcess as any).default ?? realChildProcess,
  spawn: (...args: any[]) => spawnImpl(...args),
}));

function isEdgeTtsSpawn(call: { command: string; args: string[] }): boolean {
  return call.command.includes("python") || call.args.join(" ").includes("edge_tts");
}

function isEdgeHealthImportSpawn(call: { command: string; args: string[] }): boolean {
  return call.args.includes("-c") && call.args.join(" ").includes("import edge_tts");
}

function isEdgeSynthesisSpawn(call: { command: string; args: string[] }): boolean {
  return call.args.includes("-m") && call.args.includes("edge_tts");
}

const { providers, getProviderStatus, speakWithFallback, voicesConfig } =
  await import("../../core/server.ts");

const ELEVENLABS_HOST = "elevenlabs.io";
const ELEVENLABS_TARGET = "api.elevenlabs.io";
const KOKORO_ENDPOINT = voicesConfig.providers.kokoro.endpoint || "http://127.0.0.1:8880/v1";

let fetchCalls: string[];
let realFetch: typeof globalThis.fetch;
let savedEnabled: Record<string, boolean>;

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}

beforeEach(() => {
  fetchCalls = [];
  spawnCalls = [];
  spawnImpl = recordingSpawn;

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    fetchCalls.push(urlOf(input));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;

  // Snapshot every provider's enabled flag, then force them all OFF. Each test
  // re-enables only what it needs, so a stray call can only come from the
  // provider under test (and edge-tts/say never run their real subprocesses).
  savedEnabled = {};
  for (const name of Object.keys(voicesConfig.providers)) {
    savedEnabled[name] = (voicesConfig.providers as any)[name].enabled;
    (voicesConfig.providers as any)[name].enabled = false;
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  spawnImpl = realSpawn; // restore the real spawn binding between tests
  for (const name of Object.keys(savedEnabled)) {
    (voicesConfig.providers as any)[name].enabled = savedEnabled[name];
  }
  // Reset the circuit-breaker singleton — the ElevenLabs 500 control records a
  // failure that would otherwise persist and could (eventually) open a breaker,
  // making a later isHealthy() vacuously false.
  for (const breaker of Object.values(circuitBreakers)) {
    breaker.failures = 0;
    breaker.lastFailure = 0;
    breaker.isOpen = false;
  }
});

describe("issue #26 — egress gating: no outbound calls when a provider is disabled", () => {
  test("ElevenLabs disabled → getProviderStatus performs zero fetch (none to elevenlabs.io)", async () => {
    const status = await getProviderStatus();

    expect(status.elevenlabs.enabled).toBe(false);
    expect(status.elevenlabs.wouldEgress).toBe(false);
    expect(fetchCalls.some((u) => u.includes(ELEVENLABS_HOST))).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("ElevenLabs disabled → speakWithFallback performs zero fetch (none to elevenlabs.io)", async () => {
    // All providers disabled → the chain skips every entry and returns failure
    // without touching the network.
    const result = await speakWithFallback("hello world");

    expect(result.success).toBe(false);
    expect(result.provider).toBe("none");
    expect(fetchCalls.some((u) => u.includes(ELEVENLABS_HOST))).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("Kokoro disabled → getProviderStatus performs zero fetch to the Kokoro endpoint", async () => {
    const status = await getProviderStatus();

    expect(status.kokoro.enabled).toBe(false);
    expect(status.kokoro.wouldEgress).toBe(false);
    expect(fetchCalls.some((u) => u.includes("8880"))).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });

  test("edge-tts disabled → getProviderStatus + speakWithFallback spawn no python/edge_tts process", async () => {
    // edge-tts egresses via spawn(python3 -m edge_tts ...), invisible to the
    // fetch spy — this is the spawn-channel equivalent of the fetch tests above.
    await getProviderStatus();
    const result = await speakWithFallback("hello world");

    expect(result.success).toBe(false);
    expect(spawnCalls.some(isEdgeTtsSpawn)).toBe(false);
    expect(spawnCalls.length).toBe(0);
  });

  // --- positive controls: each spy works, and `enabled` is the only gate ---

  test("Kokoro enabled → getProviderStatus probes the endpoint exactly once (positive control)", async () => {
    (voicesConfig.providers as any).kokoro.enabled = true;

    const status = await getProviderStatus();

    expect(status.kokoro.enabled).toBe(true);
    expect(status.kokoro.wouldEgress).toBe(true);
    expect(status.kokoro.egressTarget).toBe(KOKORO_ENDPOINT);
    // The health probe — and only it — hit the configured endpoint, exactly once.
    expect(fetchCalls.filter((u) => u.startsWith(KOKORO_ENDPOINT)).length).toBe(1);
  });

  test("edge-tts enabled → getProviderStatus spawns the edge_tts health probe (positive control)", async () => {
    (voicesConfig.providers as any).edgetts.enabled = true;

    const status = await getProviderStatus();

    expect(status.edgetts.enabled).toBe(true);
    expect(status.edgetts.wouldEgress).toBe(true);
    // The spy is proven live: enabling edge-tts is what makes it spawn.
    expect(spawnCalls.filter(isEdgeTtsSpawn).length).toBe(1);
    expect(spawnCalls.filter(isEdgeHealthImportSpawn).length).toBe(1);
  });

  test("edge-tts enabled → speakWithFallback does not run the diagnostic health import gate", async () => {
    (voicesConfig.providers as any).edgetts.enabled = true;

    const result = await speakWithFallback("hello world");

    expect(result.success).toBe(true);
    expect(result.provider).toBe("edgetts");
    expect(spawnCalls.filter(isEdgeHealthImportSpawn).length).toBe(0);
    expect(spawnCalls.filter(isEdgeSynthesisSpawn).length).toBe(1);
  });

  test("edge-tts health diagnostics include reason, phase, stderr, and timeout budget", async () => {
    (voicesConfig.providers as any).edgetts.enabled = true;
    spawnImpl = (command: string, args: unknown = []) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      spawnCalls.push({ command: String(command), args: argv });
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write() {}, end() {} };
      child.kill = () => {};
      child.pid = 4242;
      queueMicrotask(() => {
        child.stderr.emit("data", "edge import exploded");
        child.emit("exit", 1);
      });
      return child;
    };

    const status = await getProviderStatus();

    expect(status.edgetts.enabled).toBe(true);
    expect(status.edgetts.healthy).toBe(false);
    expect(status.edgetts.health_diagnostic?.phase).toBe("health-import");
    expect(status.edgetts.health_diagnostic?.reason).toBe("nonzero-exit");
    expect(status.edgetts.health_diagnostic?.timeout_ms).toBe(3000);
    expect(status.edgetts.health_diagnostic?.stderr).toContain("edge import exploded");
  });

  test("ElevenLabs enabled → audit + speakWithFallback egress to api.elevenlabs.io (positive control)", async () => {
    (voicesConfig.providers as any).elevenlabs.enabled = true;
    const eleven = providers.elevenlabs as any;
    const savedKey = eleven.apiKey;
    eleven.apiKey = "test-key-egress-control";

    try {
      // Audit string must read exactly api.elevenlabs.io (guards against drift).
      const status = await getProviderStatus();
      expect(status.elevenlabs.enabled).toBe(true);
      expect(status.elevenlabs.wouldEgress).toBe(true);
      expect(status.elevenlabs.egressTarget).toBe(ELEVENLABS_TARGET);

      // Return a non-ok response so speak() bails before any audio playback while
      // still proving the outbound request fired.
      globalThis.fetch = (async (input: any) => {
        fetchCalls.push(urlOf(input));
        return new Response("nope", { status: 500 });
      }) as typeof globalThis.fetch;

      await speakWithFallback("hello world");
      expect(fetchCalls.some((u) => u.includes(ELEVENLABS_HOST))).toBe(true);
    } finally {
      eleven.apiKey = savedKey;
    }
  });
});

describe("issue #26 — /health egress audit (getProviderStatus shape)", () => {
  test("every provider reports a boolean wouldEgress; disabled providers report false", async () => {
    const status = await getProviderStatus();

    for (const entry of Object.values(status)) {
      expect(typeof entry.wouldEgress).toBe("boolean");
      // beforeEach disabled everything → nothing would egress.
      expect(entry.wouldEgress).toBe(false);
      expect("egressTarget" in entry).toBe(false);
    }
  });

  test("macOS `say` never egresses even when enabled (fully local)", async () => {
    (voicesConfig.providers as any).say.enabled = true;

    const status = await getProviderStatus();

    expect(status.say.enabled).toBe(true);
    expect(status.say.wouldEgress).toBe(false);
    expect("egressTarget" in status.say).toBe(false);
    expect(fetchCalls.length).toBe(0);
    expect(spawnCalls.length).toBe(0);
  });
});
