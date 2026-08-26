import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMMANDS = "adapters/claudecode/commands";

describe("claude /echo-mute command file", () => {
  test("sits beside /echo-voice and drives cli/echo mute", () => {
    expect(readdirSync(COMMANDS).sort()).toEqual(["echo-mute.md", "echo-voice.md"]);
    expect(existsSync(join(COMMANDS, "echo-mute.md"))).toBe(true);
    const md = readFileSync(join(COMMANDS, "echo-mute.md"), "utf8");
    expect(md).toContain('bash "$CLI" mute');
    expect(md).toContain("cli/echo");
    expect(md).toContain("argument-hint: [on|off|toggle|status|duration]");
  });
});
