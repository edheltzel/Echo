import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const workflow = readFileSync(".github/workflows/verify.yml", "utf8");
const notBundled = new Set(["claudecode"]);

function bundledAdapters(): string[] {
  return readdirSync("adapters")
    .filter((name: string) => statSync(join("adapters", name)).isDirectory())
    .filter((name: string) => !notBundled.has(name))
    .filter((name: string) => {
      try {
        return statSync(join("adapters", name, "package.json")).isFile();
      } catch {
        return false;
      }
    });
}

describe("CI gates every shipped adapter build", () => {
  test("each bundled adapter package has a build step", () => {
    const ungated = bundledAdapters().filter((name) => !workflow.includes(`bun build adapters/${name}/`));
    expect(ungated).toEqual([]);
  });

  test("MCP has an explicit build gate", () => {
    expect(workflow).toContain("bun build adapters/mcp/server.ts --target=bun --outdir /tmp/echo-mcp-build");
  });
});
