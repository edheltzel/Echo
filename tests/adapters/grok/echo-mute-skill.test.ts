import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const SKILL = "adapters/grok/skills/echo-mute/SKILL.md";

describe("grok /echo-mute skill", () => {
  test("drives bash cli/echo mute and never Bun or POST /mute", () => {
    expect(existsSync(SKILL)).toBe(true);
    const md = readFileSync(SKILL, "utf8");
    expect(md).toContain("user-invocable: true");
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).not.toContain("Bun.spawn");
    expect(md).not.toMatch(/POST\s+\/mute/);
    expect(md).not.toMatch(/curl[^\n]*\/mute/);
  });
});
