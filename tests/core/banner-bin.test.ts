import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateEchoConfig } from "../../shared/echo-env.ts";

// The suite's core/server.ts singleton captured tests/preload.ts's no-op banner
// executable at first import, so the default and the override are each proved in
// a fresh `bun test` child that imports core itself. The child stubs
// node:child_process, so even the default case never spawns the real osascript.
const ROOT = resolve(import.meta.dir, "../..");

const CHILD = `
import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChildProcess from "node:child_process";
import { writeFileSync } from "node:fs";

// Resolves on the banner spawn itself; other spawns (the edge-tts health probe) are ignored.
const banner = Promise.withResolvers<{ command: string; args: string[] }>();
mock.module("node:child_process", () => ({
  ...realChildProcess,
  default: "default" in realChildProcess ? realChildProcess.default : realChildProcess,
  spawn: (command: string, args: string[]) => {
    if (String(args?.[1]).includes("display notification")) banner.resolve({ command, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { write() {}, end() {} }, kill() {}, pid: 4242,
    });
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  },
}));

const bin = process.env.BANNER_CHILD_BIN;
if (bin) process.env.ECHO_OSASCRIPT_BIN = bin;
else delete process.env.ECHO_OSASCRIPT_BIN;

test("banner spawn", async () => {
  // Dynamic on purpose: core must load after the child_process mock and the env above.
  const { server } = await import(process.env.BANNER_CHILD_SERVER!);
  const res = await fetch(\`http://localhost:\${server.port}/notify\`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "banner probe", title: "Probe", voice_enabled: false }),
  });
  expect(res.status).toBe(202);
  writeFileSync(process.env.BANNER_CHILD_RESULT!, JSON.stringify(await banner.promise));
});
`;

function bannerSpawn(bin: string | undefined): { command: string; args: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "echo-banner-bin-"));
  try {
    const child = join(scratch, "banner-child.test.ts");
    const result = join(scratch, "spawned.json");
    writeFileSync(child, CHILD);
    const proc = Bun.spawnSync(["bun", "test", child], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: "0",
        BANNER_CHILD_SERVER: join(ROOT, "core/server.ts"),
        BANNER_CHILD_RESULT: result,
        BANNER_CHILD_BIN: bin ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    if (proc.exitCode !== 0) throw new Error(`banner child failed:\n${proc.stderr.toString()}`);
    return JSON.parse(readFileSync(result, "utf8"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe("ECHO_OSASCRIPT_BIN", () => {
  test("unset: the banner spawns /usr/bin/osascript with a display notification script", () => {
    const banner = bannerSpawn(undefined);
    expect(banner.command).toBe("/usr/bin/osascript");
    expect(banner.args[0]).toBe("-e");
    expect(banner.args[1]).toContain('display notification "banner probe" with title "Probe"');
  }, 40_000);

  test("set: the banner spawns that executable with the same arguments", () => {
    const banner = bannerSpawn("/opt/recorder/banner");
    expect(banner.command).toBe("/opt/recorder/banner");
    expect(banner.args[0]).toBe("-e");
    expect(banner.args[1]).toContain('display notification "banner probe"');
  }, 40_000);

  test("config.json accepts the key", () => {
    expect(validateEchoConfig({ ECHO_OSASCRIPT_BIN: "/usr/bin/true" })).toEqual([]);
  });
});
