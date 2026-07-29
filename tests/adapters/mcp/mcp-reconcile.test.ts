import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Every run here points ECHO_MCP_CONFIG_PATH at a scratch file, so the
// operator's real ~/.claude.json is never read for mutation and never written.
// This mirrors tests/adapters/claudecode/restore-hooks-paths.test.ts.

const RECONCILE = resolve("adapters/mcp/reconcile.ts");
const CANONICAL = resolve("adapters/mcp/server.ts");

let scratch: string;
let configPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-mcp-reconcile-"));
  configPath = join(scratch, "claude.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[] = [], path = configPath) {
  const result = Bun.spawnSync(["bun", RECONCILE, ...args], {
    env: { ...process.env, ECHO_MCP_CONFIG_PATH: path },
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function readConfig(path = configPath): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeConfig(value: unknown, path = configPath): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("registering the MCP server", () => {
  test("registers the canonical entry derived from the adapter's own location", () => {
    writeConfig({ mcpServers: {} });

    const result = run();

    expect(result.code).toBe(0);
    const entry = readConfig().mcpServers["echo-converse"];
    expect(entry).toEqual({ type: "stdio", command: "bun", args: [CANONICAL] });
  });

  test("a missing config file is created rather than treated as an error", () => {
    const result = run();

    expect(result.code).toBe(0);
    expect(readConfig().mcpServers["echo-converse"].args).toEqual([CANONICAL]);
  });

  test("rerunning against a correct config changes nothing", () => {
    run();
    const before = readFileSync(configPath, "utf8");

    const result = run();

    expect(result.code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(result.stdout).toContain("already current");
  });

  test("unrelated config is preserved untouched", () => {
    writeConfig({
      numStartups: 42,
      mcpServers: { "some-other-server": { type: "stdio", command: "node", args: ["/opt/other/server.js"] } },
      projects: { "/repo": { allowedTools: [] } },
    });

    run();

    const config = readConfig();
    expect(config.numStartups).toBe(42);
    expect(config.projects).toEqual({ "/repo": { allowedTools: [] } });
    expect(config.mcpServers["some-other-server"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["/opt/other/server.js"],
    });
  });
});

describe("pruning stale registrations", () => {
  test("repoints an entry left behind by a renamed clone", () => {
    writeConfig({
      mcpServers: {
        "echo-converse": { type: "stdio", command: "bun", args: ["/old/clone/adapters/mcp/server.ts"] },
      },
    });

    const result = run();

    expect(result.code).toBe(0);
    expect(readConfig().mcpServers["echo-converse"].args).toEqual([CANONICAL]);
    expect(result.stdout).toContain("repoint");
  });

  test("removes an echo MCP registration hiding under another name", () => {
    // A duplicate would expose the same tool twice in every session.
    writeConfig({
      mcpServers: {
        "echo-voice-ask": { type: "stdio", command: "bun", args: ["/old/clone/adapters/mcp/server.ts"] },
      },
    });

    run();

    const servers = readConfig().mcpServers;
    expect(servers["echo-voice-ask"]).toBeUndefined();
    expect(servers["echo-converse"].args).toEqual([CANONICAL]);
  });

  test("a foreign server holding our name is fatal, never overwritten", () => {
    writeConfig({
      mcpServers: { "echo-converse": { type: "stdio", command: "python3", args: ["/somebody/else/thing.py"] } },
    });

    const result = run();

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not an echo adapter");
    // The config must be exactly as it was.
    expect(readConfig().mcpServers["echo-converse"].command).toBe("python3");
  });
});

describe("--check", () => {
  test("reports pending changes with exit 3 and mutates nothing", () => {
    writeConfig({ mcpServers: {} });

    const result = run(["--check"]);

    expect(result.code).toBe(3);
    expect(result.stdout).toContain("pending:");
    expect(readConfig().mcpServers["echo-converse"]).toBeUndefined();
  });

  test("reports a current config with exit 0", () => {
    run();

    const result = run(["--check"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("current:");
  });

  test("reports a fatal collision with exit 2 without mutating", () => {
    writeConfig({ mcpServers: { "echo-converse": { type: "stdio", command: "node", args: ["/other.js"] } } });

    const result = run(["--check"]);

    expect(result.code).toBe(2);
    expect(readConfig().mcpServers["echo-converse"].command).toBe("node");
  });
});

describe("symlinked config", () => {
  test("writes through the link instead of replacing it", () => {
    const realConfig = join(scratch, "real-claude.json");
    const linked = join(scratch, "linked-claude.json");
    writeConfig({ mcpServers: {} }, realConfig);
    symlinkSync(realConfig, linked);

    const result = run([], linked);

    expect(result.code).toBe(0);
    // The link survives and the real file behind it carries the entry.
    expect(readConfig(realConfig).mcpServers["echo-converse"].args).toEqual([CANONICAL]);
    expect(Bun.spawnSync(["test", "-L", linked]).exitCode).toBe(0);
    expect(existsSync(`${realConfig}.echo-mcp.tmp`)).toBe(false);
  });
});
