import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEchoMuteCommand,
  parseMuteArgs,
  runEchoMute,
  type MuteRunResult,
} from "../../shared/mute-command";
import type { ScaffoldContext } from "../../shared/persona-scaffold";

describe("parseMuteArgs", () => {
  test("empty → status; otherwise pass tokens through", () => {
    expect(parseMuteArgs("")).toEqual(["status"]);
    expect(parseMuteArgs("   ")).toEqual(["status"]);
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

  test("spawns the given CLI with mute + args (never the live daemon)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mute-cli-"));
    roots.push(root);
    const cli = join(root, "echo");
    writeFileSync(cli, "#!/bin/bash\nprintf 'argv:%s\\n' \"$*\"\nexit 0\n", { mode: 0o755 });

    const result = await runEchoMute(cli, ["30m"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("argv:mute 30m");
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
    await cmd.handler("on", ctx(notes));
    expect(seen).toEqual({ cliPath: "/stub/cli/echo", muteArgs: ["on"] });
    expect(notes.at(-1)).toEqual({ msg: '{"muted":true}', type: "info" });
  });

  test("bare args request status; nonzero exit is an error notify", async () => {
    const notes: Array<{ msg: string; type?: string }> = [];
    const cmd = createEchoMuteCommand({
      run: async (_cliPath, muteArgs): Promise<MuteRunResult> => {
        expect(muteArgs).toEqual(["status"]);
        return { exitCode: 2, stdout: "", stderr: "Usage: echo mute …\n" };
      },
    });
    await cmd.handler("", ctx(notes));
    expect(notes.at(-1)).toEqual({ msg: "Usage: echo mute …", type: "error" });
  });
});
