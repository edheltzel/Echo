import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Runtime companion to the static scan in architecture-invariants.test.ts
// ("core/ never writes to process.env"). A source regex can only see the
// decidable write forms — the regression this file exists to catch was
// `loadEchoEnvironment(process.env)`, a plain function call that mutates its
// argument. Only actually importing the daemon proves the module graph leaves
// the environment alone.
//
// Non-vacuity matters here: on a machine with no env files there is nothing to
// leak, so the probe file below GIVES the daemon something to leak. The child
// asserts the probe is visible through resolveEchoEnv (the file layer really
// was loaded) while absent from process.env (it was never hydrated). Re-adding
// import-time hydration turns this red.
//
// The child runs in its own process with every daemon state path redirected
// into scratch — it must never read or rewrite the operator's real mute state,
// capture state, caches, logs, or voice config.

const ROOT = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "echo-import-purity-"));

// Importing the daemon runs its top-level `await getProviderStatus()`, which
// spawns the edge-tts health probe. Bun.spawnSync blocks this thread, so the
// bun-test timeout below cannot preempt it — the child must carry its own
// deadline, kept under the test's so a stall fails readably here instead of
// wedging the suite until the CI job dies.
const CHILD_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 90_000;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CHILD = `
import { writeFileSync } from "node:fs";

const [target, envModule, out] = process.argv.slice(2);
const before = { ...process.env };
await import(target);
const after = { ...process.env };
const { resolveEchoEnv } = await import(envModule);

writeFileSync(
  out,
  JSON.stringify({
    added: Object.keys(after).filter((key) => !(key in before)),
    changed: Object.keys(before).filter((key) => before[key] !== after[key]),
    fileLayerProbe: resolveEchoEnv("ECHO_IMPORT_PURITY_PROBE") ?? null,
  }),
);
// core/server.ts binds Bun.serve, which holds the event loop open.
process.exit(0);
`;

function importCoreServer(): { added: string[]; changed: string[]; fileLayerProbe: string | null } {
  const child = join(scratch, "import-core-server.ts");
  const result = join(scratch, "result.json");
  const probeEnv = join(scratch, "probe.env");
  const voices = join(scratch, "voices.json");

  writeFileSync(child, CHILD);
  writeFileSync(probeEnv, 'ECHO_IMPORT_PURITY_PROBE=leaked\nECHO_DEFAULT_TITLE="Probe Title"\n');
  copyFileSync(join(ROOT, "core", "voices.json"), voices);

  const proc = Bun.spawnSync(
    ["bun", "run", child, resolve(ROOT, "core/server.ts"), resolve(ROOT, "core/env.ts"), result],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: "0",
        ECHO_ENV_PATHS: probeEnv,
        VOICES_PATH: voices,
        ECHO_MUTE_STATE_PATH: join(scratch, "mute.json"),
        ECHO_CAPTURE_STATE_PATH: join(scratch, "recording-state.json"),
        ECHO_AUDIO_CACHE_DIR: join(scratch, "audio-cache"),
        ECHO_AUDIO_LIFECYCLE_LOG: join(scratch, "audio-lifecycle.jsonl"),
        ECHO_VOICE_EVENTS_LOG: join(scratch, "voice-events.jsonl"),
        ECHO_TTS_CACHE_DIR: join(scratch, "tts-cache"),
        ECHO_RESOLUTION_LOG: join(scratch, "voice-resolution.jsonl"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );

  if (proc.exitCode !== 0) {
    const how = proc.signalCode
      ? `killed by ${proc.signalCode}, child deadline ${CHILD_TIMEOUT_MS}ms`
      : `exit ${proc.exitCode}`;
    throw new Error(
      `Importing core/server.ts in an isolated process failed (${how}):\n` + proc.stderr.toString(),
    );
  }
  return JSON.parse(readFileSync(result, "utf8"));
}

describe("core import purity — importing the daemon must not mutate process.env", () => {
  test("env-file values stay in the read-only file layer, never hydrated into process.env", () => {
    const { added, changed, fileLayerProbe } = importCoreServer();

    // Guards against a vacuous pass: the probe must actually be reachable
    // through the file layer, or "nothing leaked" proves nothing.
    expect(fileLayerProbe).toBe("leaked");

    expect({ added, changed }).toEqual({ added: [], changed: [] });
  }, TEST_TIMEOUT_MS);
});
