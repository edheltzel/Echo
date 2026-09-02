import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEchoMuteCommand,
  hasBunSpawn,
  parseMuteArgs,
  runEchoMute,
  runEchoMutePosix,
  type MuteRunResult,
} from "../../shared/mute-command";
import type { ScaffoldContext } from "../../shared/persona-scaffold";

describe("parseMuteArgs", () => {
  test("empty → toggle; otherwise pass tokens through", () => {
    expect(parseMuteArgs("")).toEqual(["toggle"]);
    expect(parseMuteArgs("   ")).toEqual(["toggle"]);
    expect(parseMuteArgs("on")).toEqual(["on"]);
    expect(parseMuteArgs("  toggle  ")).toEqual(["toggle"]);
    expect(parseMuteArgs("30m")).toEqual(["30m"]);
    expect(parseMuteArgs("on 30")).toEqual(["on", "30"]);
  });
});

describe("runEchoMute", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function stubCli(name: string): string {
    const root = mkdtempSync(join(tmpdir(), name));
    roots.push(root);
    const cli = join(root, "echo");
    writeFileSync(cli, "#!/bin/bash\nprintf 'argv:%s\\n' \"$*\"\nexit 0\n", { mode: 0o755 });
    return cli;
  }

  test("spawns the given CLI with mute + args (never the live daemon)", async () => {
    const result = await runEchoMute(stubCli("echo-mute-cli-"), ["30m"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("argv:mute 30m");
  });

  test("posix spawn path runs bash cli/echo mute without Bun.spawn", async () => {
    const result = await runEchoMutePosix(stubCli("echo-mute-posix-"), ["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("argv:mute status");
  });
});

describe("mute-command Pi-safe spawn", () => {
  test("source does not treat Bun.spawn as a hard requirement", () => {
    const src = readFileSync("shared/mute-command.ts", "utf8");
    expect(src).toContain("node:child_process");
    expect(src).toContain("runEchoMutePosix");
    expect(src).toContain('"/bin/bash"');
    expect(src).toMatch(/hasBunSpawn|Bun\?\.spawn/);
    expect(src).not.toMatch(/fetch\([^)]*\/mute/);
    expect(src).not.toMatch(/\bcurl\b[^\n]*\/mute/);
    // Bun.spawn may exist as a fast path, but the default runner must fall
    // through to POSIX spawn when the Bun global is missing (Pi).
    expect(src).toContain("if (hasBunSpawn())");
    expect(src).toContain("return runEchoMutePosix");
  });

  test("hasBunSpawn reflects this process without throwing", () => {
    expect(typeof hasBunSpawn()).toBe("boolean");
    expect(hasBunSpawn()).toBe(typeof (globalThis as { Bun?: { spawn?: unknown } }).Bun?.spawn === "function");
  });
});

describe("createEchoMuteCommand", () => {
  function ctx(notes: Array<{ msg: string; type?: string }>): ScaffoldContext {
    return { cwd: "/tmp", ui: { input: async () => undefined, notify: (msg, type) => notes.push({ msg, type }) } };
  }

  test("forwards parsed args to the injected runner and notifies stdout", async () => {
    const notes: Array<{ msg: string; type?: string }> = [];
    let seen: { cliPath: string; muteArgs: string[] } | undefined;
    const cmd = createEchoMuteCommand({
      cliPath: "/stub/cli/echo",
      run: async (cliPath, muteArgs): Promise<MuteRunResult> => {
        seen = { cliPath, muteArgs };
        return { exitCode: 0, stdout: '{"muted":true}\n', stderr: "" };
      },
    });
    expect(cmd.description).toContain("every session on this machine");
    await cmd.handler("on", ctx(notes));
    expect(seen).toEqual({ cliPath: "/stub/cli/echo", muteArgs: ["on"] });
    expect(notes.at(-1)).toEqual({ msg: '{"muted":true}', type: "info" });
  });

  test("bare args request toggle; nonzero exit is an error notify", async () => {
    const notes: Array<{ msg: string; type?: string }> = [];
    const cmd = createEchoMuteCommand({
      run: async (_cliPath, muteArgs): Promise<MuteRunResult> => {
        expect(muteArgs).toEqual(["toggle"]);
        return { exitCode: 2, stdout: "", stderr: "Usage: echo mute …\n" };
      },
    });
    await cmd.handler("", ctx(notes));
    expect(notes.at(-1)).toEqual({ msg: "Usage: echo mute …", type: "error" });
  });
});
