import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const docs = [
  "docs/getting-started.md",
  "docs/install-human.md",
  "docs/install-agent.md",
  "docs/operations.md",
  "docs/configuration.md",
  "docs/http-api.md",
  "docs/voices.md",
  "docs/providers-observability.md",
  "docs/reliability.md",
  "docs/dependencies.md",
  "docs/development.md",
  "CONTRIBUTING.md",
];

describe("documentation links", () => {
  test("README links to required docs", () => {
    const readme = readFileSync("README.md", "utf8");
    for (const doc of docs) {
      expect(existsSync(doc)).toBe(true);
      expect(readme).toContain(doc);
    }
  });

  test("agent guide points at the neutral service and current core paths", () => {
    const guide = readFileSync("AGENTS.md", "utf8");
    expect(guide).toContain("core/server.ts");
    expect(guide).toContain("com.echo");
    expect(guide).not.toContain("Canonical server source | `claudecode/.claude/PAI/USER/Voice/server.ts`");
    expect(guide).not.toContain("POST /pai");
    expect(guide).not.toContain("pai-voice-server.log");
  });
});
