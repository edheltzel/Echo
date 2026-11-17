import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const repo = join(import.meta.dir, "../..");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version as string;
let scratch = "";
let packageRoot = "";
let tarball = "";

function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd = scratch, timeout = 15_000) {
  return spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", timeout });
}

async function extractTarball(tarball: string, dest: string) {
  // Bun.Archive drops file modes, so read them from the tar headers.
  const modes = tarModes(gunzipSync(readFileSync(tarball)));
  const entries = await new Bun.Archive(gunzipSync(readFileSync(tarball))).files();
  for (const [name, file] of entries) {
    if (name.endsWith("/")) continue;
    const out = join(dest, name);
    mkdirSync(join(out, ".."), { recursive: true });
    await Bun.write(out, await file.bytes());
    chmodSync(out, modes.get(name) ?? 0o644);
  }
}

function tarModes(tar: Uint8Array): Map<string, number> {
  const modes = new Map<string, number>();
  const dec = new TextDecoder();
  for (let off = 0; off + 512 <= tar.length; ) {
    if (tar[off] === 0) break;
    const name = dec.decode(tar.subarray(off, off + 100)).replace(/\0+$/, "");
    const prefix = dec.decode(tar.subarray(off + 345, off + 500)).replace(/\0+$/, "");
    const mode = parseInt(dec.decode(tar.subarray(off + 100, off + 108)).replace(/\0.*/, "").trim(), 8);
    const size = parseInt(dec.decode(tar.subarray(off + 124, off + 136)).replace(/\0.*/, "").trim(), 8);
    modes.set(prefix ? `${prefix}/${name}` : name, mode);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return modes;
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "agent-echo-"));
  const pack = run("npm", ["pack", repo, "--pack-destination", scratch]);
  expect(pack.status, pack.stderr || pack.error?.message || "npm pack failed").toBe(0);
  const filename = pack.stdout.trim().split("\n").pop() ?? "";
  tarball = join(scratch, filename);
  expect(existsSync(tarball), pack.stderr || pack.error?.message || "no tarball").toBe(true);
  await extractTarball(tarball, scratch);
  packageRoot = join(scratch, "package");
}, 30_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("agent-echo npm package", () => {
  test("ships the runtime tree and nothing test- or tool-local", () => {
    for (const path of ["cli/agent-echo", "cli/echo", "core/server.ts", "scripts/install.sh", "adapters/empryo/hook.ts", "shared/echo-env.ts"]) {
      expect(existsSync(join(packageRoot, path))).toBe(true);
    }
    for (const path of ["tests", "docs", "node_modules", "adapters/claudecode/.empryo", "todo.txt"]) {
      expect(existsSync(join(packageRoot, path))).toBe(false);
    }
  });

  test("the bin runs through an npm-style symlink and reports the package version", () => {
    const bin = join(scratch, "agent-echo-link");
    expect(run("ln", ["-s", join(packageRoot, "cli/agent-echo"), bin]).status).toBe(0);
    const result = run(bin, ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    expect(run(bin, ["--help"]).stdout).toContain("agent-echo install");
  });

  test("stage copies the package to a stable source directory and replaces it on update", () => {
    const sourceHome = join(scratch, "home", "source");
    const env = { ECHO_SOURCE_HOME: sourceHome };
    const bin = join(packageRoot, "cli/agent-echo");
    expect(run(bin, ["where"], env).status).toBe(1);

    const first = run(bin, ["stage"], env);
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe(sourceHome);
    expect(existsSync(join(sourceHome, "cli/echo"))).toBe(true);
    writeFileSync(join(sourceHome, "stale-file"), "old");

    expect(run(bin, ["stage"], env).status).toBe(0);
    expect(existsSync(join(sourceHome, "stale-file"))).toBe(false);
    expect(run(bin, ["where"], env).stdout.trim()).toBe(sourceHome);
  });

  test("a staged tree links the workspace without a lockfile", () => {
    const sourceHome = join(scratch, "linked", "source");
    expect(run(join(packageRoot, "cli/agent-echo"), ["stage"], { ECHO_SOURCE_HOME: sourceHome }).status).toBe(0);
    expect(existsSync(join(sourceHome, "bun.lock"))).toBe(false);
    const install = run("bun", ["install", "--production"], {}, sourceHome);
    expect(install.status).toBe(0);
    expect(existsSync(join(sourceHome, "adapters/empryo/node_modules/@echo/shared/echo-env.ts"))).toBe(true);
  }, 60_000);

  test.skipIf(process.platform !== "darwin")("npx installs, controls, and updates a real isolated daemon without a clone", async () => {
    const root = join(scratch, "lifecycle");
    const home = join(root, "home");
    const bin = join(root, "bin");
    const cwd = join(root, "caller");
    const configPath = join(home, ".config/echo/config.json");
    for (const dir of [bin, cwd, join(configPath, "..")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "echo-npm-caller", private: true }));

    const updatedVersion = "99.0.0";
    const updatedPackage = join(root, "release");
    cpSync(packageRoot, updatedPackage, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(updatedPackage, "package.json"), "utf8"));
    writeFileSync(join(updatedPackage, "package.json"), JSON.stringify({ ...manifest, version: updatedVersion }));
    const pack = run("npm", ["pack", updatedPackage, "--pack-destination", root]);
    expect(pack.status, pack.stderr || pack.error?.message).toBe(0);
    const updatedTarball = join(root, pack.stdout.trim().split("\n").pop()!);

    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    expect(port).not.toBe(3246);
    reservation.stop(true);
    const config = JSON.stringify({
      PORT: port,
      ECHO_PREFERRED_NAME: "npm lifecycle tester",
      ECHO_OSASCRIPT_BIN: "/usr/bin/true",
      ECHO_SAY_BIN: "/usr/bin/true",
    }, null, 2);
    writeFileSync(configPath, config);

    let latest = version;
    let daemon: ReturnType<typeof Bun.spawn> | undefined;
    const daemonLog = join(root, "daemon.log");
    const stopDaemon = async () => {
      if (!daemon) return;
      const child = daemon;
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await child.exited; } finally { clearTimeout(timer); daemon = undefined; }
    };
    const registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/agent-echo") {
          const releases = Object.fromEntries([version, updatedVersion].map((release) => [release, {
            ...manifest,
            version: release,
            dist: { tarball: `${new URL(request.url).origin}/agent-echo/-/${release}.tgz` },
          }]));
          return Response.json({ name: "agent-echo", "dist-tags": { latest }, versions: releases });
        }
        if (path === `/agent-echo/-/${version}.tgz`) return new Response(Bun.file(tarball));
        if (path === `/agent-echo/-/${updatedVersion}.tgz`) return new Response(Bun.file(updatedTarball));
        if (path === "/launchctl/list") {
          return new Response(daemon && daemon.exitCode === null ? `${daemon.pid}\t0\tcom.echo\n` : "");
        }
        if (path === "/launchctl/unload") {
          expect(await request.text()).toBe(join(home, "Library/LaunchAgents/com.echo.plist"));
          await stopDaemon();
          return new Response();
        }
        if (path === "/launchctl/load") {
          const plistPath = await request.text();
          expect(plistPath).toBe(join(home, "Library/LaunchAgents/com.echo.plist"));
          const parsed = run("plutil", ["-convert", "json", "-o", "-", plistPath]);
          expect(parsed.status, parsed.stderr).toBe(0);
          const plist = JSON.parse(parsed.stdout);
          expect(plist.Label).toBe("com.echo");
          expect(plist.EnvironmentVariables.HOME).toBe(home);
          expect(plist.WorkingDirectory).toBe(join(home, "Library/Application Support/echo/payload/current"));
          expect(plist.ProgramArguments[2]).toBe(join(plist.WorkingDirectory, "core/server.ts"));
          daemon = Bun.spawn(plist.ProgramArguments, {
            cwd: plist.WorkingDirectory,
            env: plist.EnvironmentVariables,
            stdout: Bun.file(daemonLog),
            stderr: Bun.file(daemonLog),
          });
          return new Response();
        }
        return new Response("Unknown test service request", { status: 404 });
      },
    });
    writeFileSync(join(bin, "launchctl"), `#!/bin/bash
exec curl -fsS --max-time 15 -X POST --data-binary "\${2:-}" "http://127.0.0.1:${registry.port}/launchctl/\${1:-}"
`, { mode: 0o755 });
    const env = {
      HOME: home,
      PATH: [bin, join(Bun.which("bun")!, ".."), join(Bun.which("npx")!, ".."), join(Bun.which("node")!, ".."), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      TMPDIR: root,
      ECHO_SKIP_WORKSPACE_LINK: "1",
      npm_config_registry: `http://127.0.0.1:${registry.port}`,
      npm_config_cache: join(root, "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
    };
    const npx = async (...args: string[]) => {
      const child = Bun.spawn(["npx", "--yes", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
      try {
        const [status, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(status, `${stdout}\n${stderr}\n${existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : ""}`).toBe(0);
        return stdout;
      } finally { clearTimeout(timer); }
    };
    const health = async () => {
      expect(daemon?.exitCode).toBeNull();
      const response = await fetch(`http://localhost:${port}/health`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe("healthy");
      expect(body.port).toBe(port);
      return body;
    };
    try {
      expect(await npx("agent-echo", "install", "--adapter", "none")).toContain(`OK echo is healthy on :${port}`);
      expect((await health()).version).toBe(version);
      const firstPid = daemon!.pid;
      expect(await npx("agent-echo", "status")).toContain(`running on :${port}`);
      expect(await npx("agent-echo", "doctor")).toContain("Result: READY");
      expect(await npx("agent-echo", "mute", "on")).toContain("Mute: ON");
      expect((await health()).mute.muted).toBe(true);
      expect(await npx("agent-echo", "mute", "off")).toContain("Mute: OFF");
      expect((await health()).mute.muted).toBe(false);

      latest = updatedVersion;
      expect(await npx("agent-echo@latest", "update")).toContain(`OK echo is healthy on :${port}`);
      expect((await health()).version).toBe(updatedVersion);
      expect(daemon!.pid).not.toBe(firstPid);
      expect(readFileSync(configPath, "utf8")).toBe(config);
      expect(await npx("agent-echo", "doctor")).toContain("Result: READY");
    } finally {
      await stopDaemon();
      registry.stop(true);
    }
  }, 90_000);
});
