// Issue #83 — scripts/mute.sh: one-command mute control.
//
// Thin curl wrapper over POST /mute and GET /health, exercised against the
// shared ephemeral test daemon (PORT=0 harness pattern). The script's curl
// carries no x-forwarded-for, so its requests land in the suite-wide
// 'localhost' rate-limit bucket (10/min) — this file spends 5 of them;
// TypeScript-side tests use their own buckets to preserve that headroom.
process.env.PORT = "0";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "mute-sh-"));
const MUTE_PATH = join(TMP, "mute.json");
process.env.ECHO_MUTE_STATE_PATH = MUTE_PATH;
process.env.ECHO_AUDIO_CACHE_DIR ??= join(TMP, "audio-cache");

const { readMuteState, writeMuteState } = await import("../../core/mute.ts");
const { server } = await import("../../core/server.ts");
const PORT = String((server as any).port);

async function runMute(args: string[], port: string = PORT) {
  const proc = Bun.spawn(["/bin/bash", "scripts/mute.sh", ...args], {
    env: { ...process.env, PORT: port },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

beforeEach(() => {
  if (existsSync(MUTE_PATH)) rmSync(MUTE_PATH);
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("issue #83 — scripts/mute.sh", () => {
  test("on → daemon muted indefinitely", async () => {
    const result = await runMute(["on"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"muted":true');
    expect(readMuteState(MUTE_PATH)).toEqual({ muted: true, muted_until: null });
  });

  test("on 45 → duration passes through to a deadline", async () => {
    const before = Date.now();
    const result = await runMute(["on", "45"]);
    expect(result.exitCode).toBe(0);
    const state = readMuteState(MUTE_PATH);
    expect(state.muted).toBe(true);
    const deadline = Date.parse(state.muted_until!);
    expect(deadline).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 45 * 60_000);
  });

  test("off → daemon unmuted", async () => {
    writeMuteState({ muted: true, muted_until: null });
    const result = await runMute(["off"]);
    expect(result.exitCode).toBe(0);
    expect(readMuteState(MUTE_PATH)).toEqual({ muted: false, muted_until: null });
  });

  test("toggle → flips current state", async () => {
    writeMuteState({ muted: true, muted_until: null });
    const result = await runMute(["toggle"]);
    expect(result.exitCode).toBe(0);
    expect(readMuteState(MUTE_PATH).muted).toBe(false);
  });

  test("status → reports mute state from /health", async () => {
    writeMuteState({ muted: true, muted_until: null });
    const result = await runMute(["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"muted":true');
  });

  test("invalid minutes argument → usage error, no request", async () => {
    const result = await runMute(["on", "soon"]);
    expect(result.exitCode).not.toBe(0);
    expect(readMuteState(MUTE_PATH)).toEqual({ muted: false, muted_until: null });
  });

  test("unknown command → usage error", async () => {
    const result = await runMute(["loud"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("usage");
  });

  test("daemon down → clear error, non-zero exit", async () => {
    // Port 1 is never the daemon; connection is refused immediately.
    const result = await runMute(["status"], "1");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not reachable");
  });
});
