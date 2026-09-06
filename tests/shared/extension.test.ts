import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FEATURES, HARNESS_IDS, HARNESSES, harnessUsageIds, isHarnessId, registerEchoMute, registerEchoVoice } from "../../shared/extension.ts";
import { mergePersonaJson, type EchoVoiceCommand } from "../../shared/persona-scaffold.ts";
import type { MuteRunResult } from "../../shared/mute-command.ts";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function packageJson(): { workspaces: string[] } {
  return JSON.parse(read("package.json")) as { workspaces: string[] };
}

describe("harness catalog", () => {
  test("usage ids match install.sh and cli/echo --adapter lists", () => {
    const usage = `--adapter ${harnessUsageIds()}`;
    expect(read("scripts/install.sh")).toContain(usage);
    expect(read("cli/echo")).toContain(usage);
    expect(read("AGENTS.md")).toContain(usage);
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

  test("install.sh still has a case branch per catalog id (no second plugin loader)", () => {
    const install = read("scripts/install.sh");
    for (const id of HARNESS_IDS) {
      expect(install).toMatch(new RegExp(`^\\s*${id}\\)`, "m"));
      for (const spec of harnessByIdOrThrow(id).reconcile) {
        expect(install).toContain(spec.script);
        expect(existsSync(spec.script)).toBe(true);
      }
    }
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

  test("entries and mute paths exist; extension hosts register through shared hooks", () => {
    for (const harness of HARNESSES) {
      if (harness.entry) expect(existsSync(harness.entry)).toBe(true);
      if (harness.features.includes("mute") && harness.kind !== "extension") {
        if (!harness.mutePath) throw new Error(`${harness.id} ships mute as a file`);
        expect(existsSync(harness.mutePath)).toBe(true);
        expect(read(harness.mutePath)).toContain("cli/echo");
        expect(read(harness.mutePath)).toContain("mute");
        const muteSource = read(harness.mutePath);
        expect(muteSource).not.toMatch(/fetch\([^)]*\/mute/);
        expect(muteSource).not.toMatch(/\bcurl\b[^\n]*\/mute/);
      }
      if (harness.kind === "extension") {
        const source = read(harness.entry!);
        expect(source).toContain("registerEchoMute");
        expect(source).toContain("registerEchoVoice");
        expect(source).toContain("registerEchoAskTool");
        expect(source).toContain("sendNotification");
        expect(source).toContain("loadEchoEnvironment");
      }
    }
  });

  test("feature table points at modules that exist", () => {
    for (const feature of Object.values(FEATURES)) {
      const file = feature.module.replace("@echo/shared/", "shared/").replace("@echo/converse/", "converse/");
      expect(existsSync(file)).toBe(true);
      expect(read(file)).toContain(feature.register);
    }
    expect(FEATURES.mute.cli).toBe("cli/echo mute");
  });

  test("core/ does not import the harness catalog", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts")) continue;
        const source = read(path);
        if (source.includes("shared/extension") || source.includes("HARNESS_IDS") || source.includes("registerEchoMute")) {
          offenders.push(path);
        }
      }
    };
    walk("core");
    expect(offenders).toEqual([]);
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

function harnessByIdOrThrow(id: string) {
  const harness = HARNESSES.find((entry) => entry.id === id);
  if (!harness) throw new Error(`missing harness ${id}`);
  return harness;
}
