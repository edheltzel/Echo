// CI must gate on every entry point a host can load, and AGENTS.md must name the
// same set. The MCP adapter is the one Claude Code loads for the voice ask; it
// imports @echo/converse and its own package.json, so a build gate is exactly
// what catches a broken workspace boundary before a host does.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/verify.yml", "utf8");
const agentsMd = readFileSync("AGENTS.md", "utf8");

describe("verify workflow gates", () => {
  test("runs the tests, the smoke, and both isolated e2e scripts", () => {
    expect(workflow).toContain("run: bun test");
    expect(workflow).toContain("tests/smoke-core.sh");
    expect(workflow).toContain("tests/e2e-adapters.sh");
    expect(workflow).toContain("tests/e2e-converse.sh");
  });

  test("builds every host adapter entry point, MCP included", () => {
    expect(workflow).toContain("bun build adapters/pi/index.ts");
    expect(workflow).toContain("bun build adapters/omp/index.ts");
    expect(workflow).toContain("bun build adapters/mcp/server.ts");
  });

  test("AGENTS.md names the same pre-ship build set", () => {
    expect(agentsMd).toContain("the Pi, omp and MCP builds before shipping");
  });
});
