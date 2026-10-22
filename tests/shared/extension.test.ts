import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FEATURES, HARNESS_IDS, HARNESSES, harnessUsageIds, isHarnessId, registerEchoMode, registerEchoMute, registerEchoVoice } from "../../shared/extension.ts";
import { mergePersonaJson, type EchoVoiceCommand } from "../../shared/persona-scaffold.ts";
import type { MuteRunResult } from "../../shared/mute-command.ts";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function packageJson(): { workspaces: string[] } {
  return JSON.parse(read("package.json")) as { workspaces: string[] };
}

describe("harness catalog", () => {
  test("catalog, installer and CLI advertise the shipped adapter choices", () => {
    const ids = "none|claudecode|jcode|grok|codex|mcp|pi|omp|opencode|empryo";
    const env = { PATH: process.env.PATH, HOME: process.cwd(), ECHO_CONFIG_FILE: resolve("tmp/catalog-config.json") };
    const catalog = Bun.spawnSync([process.execPath, "scripts/harness-catalog.ts", "usage"], { env });
    expect(catalog.exitCode).toBe(0);
    expect(catalog.stdout.toString().trim()).toBe(ids);
    expect(harnessUsageIds()).toBe(ids);
    for (const entry of ["scripts/install.sh", "cli/echo"]) {
      const help = Bun.spawnSync(["/bin/bash", entry, "--help"], { env });
      expect(help.exitCode).toBe(0);
      expect(help.stdout.toString()).toContain(`--adapter ${ids}`);
    }
  });

  test("every catalog harness is a workspace package with a real package dir", () => {
    const workspaces = new Set(packageJson().workspaces);
    for (const harness of HARNESSES) {
      expect(workspaces.has(harness.packageDir)).toBe(true);
      expect(existsSync(`${harness.packageDir}/package.json`)).toBe(true);
      const manifest = JSON.parse(read(`${harness.packageDir}/package.json`)) as {
        dependencies?: Record<string, string>;
      };
      const deps = manifest.dependencies ?? {};
      expect(
        deps["@echo/shared"] === "workspace:*" || deps["@echo/converse"] === "workspace:*",
      ).toBe(true);
    }
  });

  test("catalog CLI lists Empryo as a hook adapter with mute and mode", () => {
    const catalog = Bun.spawnSync([process.execPath, "scripts/harness-catalog.ts", "list"]);
    expect(catalog.exitCode).toBe(0);
    expect(catalog.stdout.toString().trim().split("\n")).toContain("empryo\thooks\tEmpryo\tempryo\tnotify,mute,mode,greeting");
    const ids = Bun.spawnSync([process.execPath, "scripts/harness-catalog.ts", "ids"]);
    expect(ids.exitCode).toBe(0);
    expect(ids.stdout.toString().trim().split("\n")).toContain("empryo");
  });

  test("catalog ids are unique and cover every adapters/* package", () => {
    const ids = HARNESSES.map((harness) => harness.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...HARNESS_IDS]);
    const listed = new Set(packageJson().workspaces.filter((entry) => entry.startsWith("adapters/")));
    expect([...listed].sort()).toEqual([...HARNESSES.map((harness) => harness.packageDir)].sort());
  });

  test("isHarnessId rejects unknown and none", () => {
    expect(isHarnessId("pi")).toBe(true);
    expect(isHarnessId("none")).toBe(false);
    expect(isHarnessId("pai")).toBe(false);
  });

  test("catalog entry and command paths resolve to shipped files", () => {
    for (const harness of HARNESSES) {
      if (harness.entry) expect(existsSync(harness.entry)).toBe(true);
      if (harness.features.includes("mute")) {
        expect(harness.features).toContain("mode");
      }
      if (harness.features.includes("mute") && harness.kind !== "extension") {
        if (!harness.mutePath) throw new Error(`${harness.id} ships mute as a file`);
        expect(existsSync(harness.mutePath)).toBe(true);
      }
      if (harness.features.includes("mode") && harness.kind !== "extension") {
        if (!harness.modePath) throw new Error(`${harness.id} ships mode as a file`);
        expect(existsSync(harness.modePath)).toBe(true);
      }
    }
  });

  test("feature table points at modules that exist", () => {
    for (const feature of Object.values(FEATURES)) {
      const file = feature.module.replace("@echo/shared/", "shared/").replace("@echo/converse/", "converse/");
      expect(existsSync(file)).toBe(true);
    }
    expect(FEATURES.mute.cli).toBe("cli/echo mute");
    expect(FEATURES.mode.cli).toBe("cli/echo mode");
  });
});

describe("feature register hooks", () => {
  test("registerEchoMute binds echo-mute to the cli/echo mute runner", async () => {
    const commands = new Map<string, EchoVoiceCommand>();
    let seen: { cliPath: string; muteArgs: string[] } | undefined;
    registerEchoMute(
      { registerCommand: (name, command) => commands.set(name, command) },
      {
        cliPath: "/stub/cli/echo",
        run: async (cliPath, muteArgs): Promise<MuteRunResult> => {
          seen = { cliPath, muteArgs };
          return { exitCode: 0, stdout: '{"muted":true}\n', stderr: "" };
        },
      },
    );
    const command = commands.get("echo-mute");
    expect(command).toBeDefined();
    const notes: Array<{ msg: string; type?: string }> = [];
    await command!.handler("30m", {
      cwd: "/tmp",
      ui: { input: async () => undefined, notify: (msg, type) => notes.push({ msg, type }) },
    });
    expect(seen).toEqual({ cliPath: "/stub/cli/echo", muteArgs: ["30m"] });
    expect(notes.at(-1)).toEqual({ msg: '{"muted":true}', type: "info" });
  });

  test("registerEchoMode binds echo-mode to cli/echo mode", async () => {
    const commands = new Map<string, EchoVoiceCommand>();
    let seen: { cliPath: string; subcommand: string; args: string[] } | undefined;
    registerEchoMode(
      { registerCommand: (name, command) => commands.set(name, command) },
      {
        cliPath: "/stub/cli/echo",
        run: async (cliPath, subcommand, args) => {
          seen = { cliPath, subcommand, args };
          return { exitCode: 0, stdout: "Mode: speech\n", stderr: "" };
        },
      },
    );
    const command = commands.get("echo-mode");
    expect(command).toBeDefined();
    const notes: Array<{ msg: string; type?: string }> = [];
    await command!.handler("speech", {
      cwd: "/tmp",
      ui: { input: async () => undefined, notify: (msg, type) => notes.push({ msg, type }) },
    });
    expect(seen).toEqual({ cliPath: "/stub/cli/echo", subcommand: "mode", args: ["speech"] });
    expect(notes.at(-1)).toEqual({ msg: "Mode: speech", type: "info" });
  });

  test("registerEchoVoice binds echo-voice", () => {
    const commands = new Map<string, EchoVoiceCommand>();
    registerEchoVoice(
      { registerCommand: (name, command) => commands.set(name, command) },
      { configPath: [".pi", "settings.json"], merge: mergePersonaJson },
    );
    expect(commands.has("echo-voice")).toBe(true);
    expect(commands.get("echo-voice")?.description).toContain("persona");
  });
});
