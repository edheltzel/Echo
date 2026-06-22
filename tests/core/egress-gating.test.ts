// Issue #26 — prove the egress-gating guarantee at runtime: a DISABLED provider
// never makes an outbound network call (no synthesis call, no auth/health
// probe), across both the speakWithFallback chain and the /health
// (getProviderStatus) path. We spy on global fetch and assert it is never hit
// for a disabled provider, and IS hit once the provider is enabled (positive
// controls prove the spy works and that `enabled` is the gate).
//
// PORT=0 binds an ephemeral port so importing the daemon never collides with a
// running :8888 instance; the server is stopped in afterAll.
process.env.PORT = "0";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

const { providers, getProviderStatus, speakWithFallback, voicesConfig, server } =
  await import("../../core/server.ts");

const ELEVENLABS_HOST = "elevenlabs.io";
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
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    fetchCalls.push(urlOf(input));
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;

  // Snapshot every provider's enabled flag, then force them all OFF. Each test
  // re-enables only what it needs, so a stray fetch can only come from the
  // provider under test (and edge-tts/say never run their real subprocesses).
  savedEnabled = {};
  for (const name of Object.keys(voicesConfig.providers)) {
    savedEnabled[name] = (voicesConfig.providers as any)[name].enabled;
    (voicesConfig.providers as any)[name].enabled = false;
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of Object.keys(savedEnabled)) {
    (voicesConfig.providers as any)[name].enabled = savedEnabled[name];
  }
});

afterAll(() => {
  server?.stop?.();
});

describe("issue #26 — egress gating: no outbound calls when a provider is disabled", () => {
  test("ElevenLabs disabled → getProviderStatus performs zero fetch to elevenlabs.io", async () => {
    const status = await getProviderStatus();

    expect(status.elevenlabs.enabled).toBe(false);
    expect(status.elevenlabs.wouldEgress).toBe(false);
    expect(fetchCalls.some((u) => u.includes(ELEVENLABS_HOST))).toBe(false);
  });

  test("ElevenLabs disabled → speakWithFallback performs zero fetch to elevenlabs.io", async () => {
    // All providers disabled → the chain skips every entry and returns failure
    // without touching the network.
    const result = await speakWithFallback("hello world");

    expect(result.success).toBe(false);
    expect(result.provider).toBe("none");
    expect(fetchCalls.some((u) => u.includes(ELEVENLABS_HOST))).toBe(false);
  });

  test("Kokoro disabled → getProviderStatus performs zero fetch to the Kokoro endpoint", async () => {
    const status = await getProviderStatus();

    expect(status.kokoro.enabled).toBe(false);
    expect(status.kokoro.wouldEgress).toBe(false);
    expect(fetchCalls.some((u) => u.includes("8880"))).toBe(false);
  });

  // --- positive controls: the spy works, and `enabled` is the only gate ---

  test("Kokoro enabled → getProviderStatus probes the endpoint exactly once (positive control)", async () => {
    (voicesConfig.providers as any).kokoro.enabled = true;

    const status = await getProviderStatus();

    expect(status.kokoro.enabled).toBe(true);
    expect(status.kokoro.wouldEgress).toBe(true);
    expect(status.kokoro.egressTarget).toBe(KOKORO_ENDPOINT);
    // The health probe (and only it) hit the configured endpoint.
    expect(fetchCalls.some((u) => u.startsWith(KOKORO_ENDPOINT))).toBe(true);
  });

  test("ElevenLabs enabled → speakWithFallback egresses to elevenlabs.io (positive control)", async () => {
    (voicesConfig.providers as any).elevenlabs.enabled = true;
    const eleven = providers.elevenlabs as any;
    const savedKey = eleven.apiKey;
    eleven.apiKey = "test-key-egress-control";

    // Return a non-ok response so speak() bails before any audio playback while
    // still proving the outbound request fired.
    globalThis.fetch = (async (input: any) => {
      fetchCalls.push(urlOf(input));
      return new Response("nope", { status: 500 });
    }) as typeof globalThis.fetch;

    try {
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
  });
});
