import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every shipped adapter's build is gated in CI, not just the ones somebody
// remembered. An adapter whose entry point stops building would otherwise reach
// a green run: the local gate builds it and CI did not, which is how the MCP
// adapter shipped ungated despite having its own package, its own registrar
// wired into install.sh, and a hand-written JSON-RPC surface.

const WORKFLOW = readFileSync(".github/workflows/verify.yml", "utf8");

// The Claude Code adapter is hook scripts the host runs from source, so there is
// no bundle to build; `bun test` covers it instead. Every other adapter package
// ships a single entry point that is bundled.
const NOT_BUNDLED = new Set(["claudecode"]);

function bundledAdapters(): string[] {
  return readdirSync("adapters")
    .filter((name: string) => statSync(join("adapters", name)).isDirectory())
    .filter((name: string) => !NOT_BUNDLED.has(name))
    .filter((name: string) => {
      try {
        return statSync(join("adapters", name, "package.json")).isFile();
      } catch {
        return false;
      }
    });
}

describe("CI gates every shipped adapter build", () => {
  test("each bundled adapter package has a build step in verify.yml", () => {
    const ungated = bundledAdapters().filter((name) => !WORKFLOW.includes(`bun build adapters/${name}/`));
    expect(ungated).toEqual([]);
  });

  test("the MCP adapter builds without a host peer dependency to externalize", () => {
    expect(WORKFLOW).toContain("bun build adapters/mcp/server.ts --target=bun --outdir /tmp/echo-mcp-build");
  });
});
