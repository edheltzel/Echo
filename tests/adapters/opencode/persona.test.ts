import { describe, expect, test } from "bun:test";
import { applyPersonaOverride } from "../../../shared/persona.ts";
import { loadOpenCodeVoiceConfig, loadProjectPersona } from "../../../adapters/opencode/config.ts";

describe("OpenCode project daidentity", () => {
  test("defaults to the OpenCode persona when no daidentity is present", () => {
    const resolved = loadOpenCodeVoiceConfig({}, undefined, "/tmp/echo-absent-home");
    expect(resolved.personaName).toBe("OpenCode");
    expect(resolved.voiceId).toBe("opencode");
    expect(resolved.sayName).toBe(false);
  });

  test("project opencode.json overrides env defaults", () => {
    const files: Record<string, string> = {
      "/proj/opencode.json": JSON.stringify({
        plugin: ["opencode-gemini-auth"],
        daidentity: {
          name: "Themis",
          voices: { main: { voiceId: "en-GB-LibbyNeural" } },
        },
      }),
    };
    const override = loadProjectPersona("/proj", (path) => files[path] ?? null, "/home", {});
    expect(override).toEqual({
      personaName: "Themis",
      voiceId: "en-GB-LibbyNeural",
    });
    const base = loadOpenCodeVoiceConfig({ ECHO_VOICE_PERSONA_NAME: "OpenCode" }, undefined, "/tmp/echo-absent-home");
    const resolved = applyPersonaOverride(base, override);
    expect(resolved.personaName).toBe("Themis");
    expect(resolved.voiceId).toBe("en-GB-LibbyNeural");
  });

  test("global-only daidentity applies when no project file", () => {
    const override = loadProjectPersona("/proj", (path) => (
      path === "/home/.config/opencode/opencode.json"
        ? JSON.stringify({ daidentity: { name: "GlobalOpen", voiceId: "en-US-AvaNeural" } })
        : null
    ), "/home", {});
    expect(override).toEqual({ personaName: "GlobalOpen", voiceId: "en-US-AvaNeural" });
  });

  test("project wins per key; unset project keys fall through to global", () => {
    const files: Record<string, string> = {
      "/home/.config/opencode/opencode.json": JSON.stringify({
        daidentity: {
          name: "GlobalOpen",
          voices: { main: { voiceId: "global-voice" } },
          startupCatchphrases: ["Global line."],
        },
      }),
      "/proj/opencode.json": JSON.stringify({
        daidentity: { voices: { main: { voiceId: "en-AU-WilliamNeural" } } },
      }),
    };
    expect(loadProjectPersona("/proj", (path) => files[path] ?? null, "/home", {})).toEqual({
      personaName: "GlobalOpen",
      voiceId: "en-AU-WilliamNeural",
      startupCatchphrases: ["Global line."],
    });
  });

  test("global jsonc wins over sibling json", () => {
    const files: Record<string, string> = {
      "/home/.config/opencode/opencode.jsonc": JSON.stringify({
        daidentity: { name: "FromJsonc", voices: { main: { voiceId: "jsonc-voice" } } },
      }),
      "/home/.config/opencode/opencode.json": JSON.stringify({
        daidentity: { name: "FromJson", voices: { main: { voiceId: "json-voice" } } },
      }),
    };
    expect(loadProjectPersona("/proj", (path) => files[path] ?? null, "/home", {})).toEqual({
      personaName: "FromJsonc",
      voiceId: "jsonc-voice",
    });
  });

  test("project jsonc wins over project json and reads comments", () => {
    const files: Record<string, string> = {
      "/proj/opencode.jsonc": `{
        // project persona
        "daidentity": {
          "name": "JsoncProject",
          "voices": { "main": { "voiceId": "en-GB-LibbyNeural" } },
        },
      }`,
      "/proj/opencode.json": JSON.stringify({
        daidentity: { name: "JsonProject", voices: { main: { voiceId: "json-voice" } } },
      }),
    };
    expect(loadProjectPersona("/proj", (path) => files[path] ?? null, "/home", {})).toEqual({
      personaName: "JsoncProject",
      voiceId: "en-GB-LibbyNeural",
    });
  });

  test("keys merge across all three global files, as OpenCode merges them", () => {
    // opencode.jsonc wins per key; a key only opencode.json sets still applies.
    const files: Record<string, string> = {
      "/home/.config/opencode/opencode.jsonc": JSON.stringify({ daidentity: { voices: { main: { voiceId: "jsonc-voice" } } } }),
      "/home/.config/opencode/opencode.json": JSON.stringify({ daidentity: { name: "FromJson", voices: { main: { voiceId: "json-voice" } } } }),
    };
    expect(loadProjectPersona(undefined, (path) => files[path] ?? null, "/home", {})).toEqual({
      personaName: "FromJson",
      voiceId: "jsonc-voice",
    });
  });

  test("a session in a subfolder reads opencode.json from parent folders up to the worktree", () => {
    const files: Record<string, string> = {
      "/repo/opencode.json": JSON.stringify({ daidentity: { name: "RepoRoot", voices: { main: { voiceId: "root-voice" } } } }),
      "/repo/pkg/opencode.json": JSON.stringify({ daidentity: { voices: { main: { voiceId: "pkg-voice" } } } }),
      "/opencode.json": JSON.stringify({ daidentity: { name: "AboveWorktree" } }),
    };
    const read = (path: string) => files[path] ?? null;
    expect(loadProjectPersona("/repo/pkg/src", read, "/home", {}, "/repo")).toEqual({
      personaName: "RepoRoot",
      voiceId: "pkg-voice",
    });
  });

  test(".opencode folders apply over project files", () => {
    const files: Record<string, string> = {
      "/repo/opencode.json": JSON.stringify({ daidentity: { name: "ProjectFile" } }),
      "/repo/.opencode/opencode.jsonc": "{ // dot dir\n \"daidentity\": { \"name\": \"DotDir\" } }",
      "/home/.opencode/opencode.json": JSON.stringify({ daidentity: { voiceId: "home-dot-voice" } }),
    };
    expect(loadProjectPersona("/repo", (path) => files[path] ?? null, "/home", {}, "/repo")).toEqual({
      personaName: "DotDir",
      voiceId: "home-dot-voice",
    });
  });

  test("OPENCODE_DISABLE_PROJECT_CONFIG ignores project files and project .opencode folders", () => {
    const files: Record<string, string> = {
      "/home/.config/opencode/opencode.json": JSON.stringify({ daidentity: { name: "GlobalOnly" } }),
      "/repo/opencode.json": JSON.stringify({ daidentity: { name: "Project" } }),
      "/repo/.opencode/opencode.json": JSON.stringify({ daidentity: { name: "ProjectDot" } }),
    };
    const env = { OPENCODE_DISABLE_PROJECT_CONFIG: "true" };
    expect(loadProjectPersona("/repo", (path) => files[path] ?? null, "/home", env, "/repo")).toEqual({
      personaName: "GlobalOnly",
    });
  });
});
