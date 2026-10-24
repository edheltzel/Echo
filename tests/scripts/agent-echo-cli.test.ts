import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const repo = join(import.meta.dir, "../..");
const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version as string;
let scratch = "";
let packageRoot = "";

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
  // `npm pack` outlives bun's 5s hook budget, so bun reaps it and status comes back null.
  // The tarball name is the last line it prints either way; the file existing is the proof.
  const pack = run("npm", ["pack", repo, "--pack-destination", scratch]);
  const filename = pack.stdout.trim().split("\n").pop() ?? "";
  const tarball = join(scratch, filename);
  expect(existsSync(tarball), pack.stderr || pack.error?.message || "no tarball").toBe(true);
  // bun reaps a beforeAll child at 5s, so extract in-process instead of spawning tar.
  await extractTarball(tarball, scratch);
  packageRoot = join(scratch, "package");
});

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
});
