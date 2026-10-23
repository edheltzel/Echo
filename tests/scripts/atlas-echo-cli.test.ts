import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = join(import.meta.dir, "../..");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version as string;
let scratch = "";
let packageRoot = "";

function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd = scratch) {
  return spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "atlas-echo-"));
  const pack = run("npm", ["pack", repo, "--pack-destination", scratch, "--json"]);
  expect(pack.status).toBe(0);
  const report = JSON.parse(pack.stdout);
  const entry = Array.isArray(report) ? report[0] : Object.values(report)[0];
  const tarball = join(scratch, (entry as { filename: string }).filename);
  expect(run("tar", ["-xzf", tarball]).status).toBe(0);
  packageRoot = join(scratch, "package");
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("atlas-echo npm package", () => {
  test("ships the runtime tree and nothing test- or tool-local", () => {
    for (const path of ["cli/atlas-echo", "cli/echo", "core/server.ts", "scripts/install.sh", "adapters/empryo/hook.ts", "shared/echo-env.ts"]) {
      expect(existsSync(join(packageRoot, path))).toBe(true);
    }
    for (const path of ["tests", "docs", "node_modules", "adapters/claudecode/.empryo", "todo.txt"]) {
      expect(existsSync(join(packageRoot, path))).toBe(false);
    }
  });

  test("the bin runs through an npm-style symlink and reports the package version", () => {
    const bin = join(scratch, "atlas-echo-link");
    expect(run("ln", ["-s", join(packageRoot, "cli/atlas-echo"), bin]).status).toBe(0);
    const result = run(bin, ["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
    expect(run(bin, ["--help"]).stdout).toContain("atlas-echo install");
  });

  test("stage copies the package to a stable source directory and replaces it on update", () => {
    const sourceHome = join(scratch, "home", "source");
    const env = { ECHO_SOURCE_HOME: sourceHome };
    const bin = join(packageRoot, "cli/atlas-echo");
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
    expect(run(join(packageRoot, "cli/atlas-echo"), ["stage"], { ECHO_SOURCE_HOME: sourceHome }).status).toBe(0);
    expect(existsSync(join(sourceHome, "bun.lock"))).toBe(false);
    const install = run("bun", ["install", "--production"], {}, sourceHome);
    expect(install.status).toBe(0);
    expect(existsSync(join(sourceHome, "adapters/empryo/node_modules/@echo/shared/echo-env.ts"))).toBe(true);
  }, 60_000);
});
