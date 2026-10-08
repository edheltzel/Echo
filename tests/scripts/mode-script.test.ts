// scripts/mode.sh + cli/echo mode against an isolated stub. Never :3246.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type Hit = { method: string; path: string; body: string };

const hits: Hit[] = [];
let mode = "speech";

const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    hits.push({ method: req.method, path: url.pathname, body });
    if (url.pathname === "/mode" && req.method === "POST") {
      const parsed = JSON.parse(body) as { mode?: string };
      if (parsed.mode === "speech" || parsed.mode === "sounds") mode = parsed.mode;
      return Response.json({ mode });
    }
    if (url.pathname === "/health") {
      return Response.json({
        status: "healthy",
        mute: { muted: false, scope: "all", muted_until: null },
        mode,
      });
    }
    return new Response("no", { status: 404 });
  },
});

const port = String(stub.port);
const home = mkdtempSync(join(tmpdir(), "echo-mode-home-"));

function scriptEnv(): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    PORT: port,
    ECHO_CONFIG_FILE: join(home, "missing-config.json"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
}

async function run(bin: string, args: string[]) {
  const proc = Bun.spawn(["/bin/bash", bin, ...args], {
    env: scriptEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterAll(() => {
  stub.stop(true);
  rmSync(home, { recursive: true, force: true });
});

describe("scripts/mode.sh", () => {
  test("sounds posts /mode and health reports sounds", async () => {
    hits.length = 0;
    mode = "speech";
    const result = await run("scripts/mode.sh", ["sounds"]);
    expect(result.exitCode).toBe(0);
    expect(hits).toContainEqual({ method: "POST", path: "/mode", body: '{"mode":"sounds"}' });
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(health.mode).toBe("sounds");
  });

  test("status prints the current mode from /health", async () => {
    hits.length = 0;
    mode = "sounds";
    const result = await run("scripts/mode.sh", ["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mode: sounds");
    expect(hits.some((hit) => hit.method === "POST")).toBe(false);
    expect(hits.some((hit) => hit.path === "/health")).toBe(true);
  });

  test("unknown argument prints usage, exits non-zero, and does not POST", async () => {
    hits.length = 0;
    const result = await run("scripts/mode.sh", ["banana"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("usage");
    expect(hits).toEqual([]);
  });
});

describe("cli/echo mode", () => {
  test("sounds posts /mode and status prints it", async () => {
    hits.length = 0;
    mode = "speech";
    const set = await run("cli/echo", ["mode", "sounds"]);
    expect(set.exitCode).toBe(0);
    expect(hits).toContainEqual({ method: "POST", path: "/mode", body: '{"mode":"sounds"}' });
    const status = await run("cli/echo", ["mode", "status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("Mode: sounds");
  });

  test("unknown argument prints usage, exits non-zero, and does not POST", async () => {
    hits.length = 0;
    const result = await run("cli/echo", ["mode", "banana"]);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`.toLowerCase()).toContain("usage");
    expect(hits).toEqual([]);
  });
});

describe("mute status mode line", () => {
  test("prints Mode from /health", async () => {
    mode = "sounds";
    const result = await run("scripts/mute.sh", ["status"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Mode: sounds");
    expect(result.stdout).toContain("Mute:");
  });
});

describe("reconcile --check missing echo-mode", () => {
  test("codex, grok, and opencode report pending", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mode-reconcile-"));
    try {
      const cases = [
        {
          script: "adapters/codex/reconcile.ts",
          env: { ECHO_CODEX_HOOKS_FILE: join(root, "codex", "hooks.json") },
          link: join(root, "codex", "skills", "echo-mode"),
        },
        {
          script: "adapters/grok/reconcile.ts",
          env: { ECHO_GROK_HOOKS_DIR: join(root, "grok", "hooks") },
          link: join(root, "grok", "skills", "echo-mode"),
        },
        {
          script: "adapters/opencode/reconcile.ts",
          env: {
            ECHO_OPENCODE_COMMANDS_DIR: join(root, "opencode", "commands"),
            ECHO_OPENCODE_PLUGINS_DIR: join(root, "opencode", "plugins"),
            ECHO_OPENCODE_CONFIG: join(root, "opencode", "opencode.json"),
          },
          link: join(root, "opencode", "commands", "echo-mode.md"),
        },
      ];
      for (const item of cases) {
        const install = spawnSync("bun", ["run", item.script], {
          env: { ...process.env, ...item.env },
          encoding: "utf8",
        });
        expect(install.status, install.stderr).toBe(0);
        rmSync(item.link, { recursive: true, force: true });
        const check = spawnSync("bun", ["run", item.script, "--check"], {
          env: { ...process.env, ...item.env },
          encoding: "utf8",
        });
        expect(check.status, `${item.script}\n${check.stdout}\n${check.stderr}`).toBe(3);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
