import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Stage 1: the daemon runs from a versioned payload under
// ~/Library/Application Support/echo/payload, NOT the git clone, so moving/deleting
// the checkout never breaks the running service. These tests run install.sh in a
// temp HOME with stubbed launchctl/curl — they never touch the real daemon.

const REPO_ROOT = resolve(".");
const PAYLOAD_REL = "Library/Application Support/echo/payload";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

/** A temp HOME wired with stub launchctl (com.echo "loaded") + stub curl (healthy). */
function makeHome(root: string): { home: string; env: Record<string, string> } {
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; esac\nexit 0\n');
  writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
  // Stub lsof as "nothing is listening". Without it the installer's port guard
  // consults the real machine's :3246 — the operator's live daemon — and any
  // test that makes curl report unhealthy would then depend on that state.
  writeExecutable(join(bin, "lsof"), "#!/bin/bash\nexit 1\n");
  const bunDir = join(Bun.which("bun")!, "..");
  return { home, env: { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin` } };
}

async function runInstall(args: string[], env: Record<string, string>) {
  // Payload staging is what's under test; the installer must never run
  // `bun install` against the checkout's node_modules mid-`bun test`.
  const proc = Bun.spawn(["/bin/bash", "scripts/install.sh", ...args], {
    env: { ECHO_SKIP_WORKSPACE_LINK: "1", ...env },
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

const version = (() => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
})();

// Every install.sh run sleeps 2s waiting for launchd to settle, so a test that
// drives two of them plus a --check exceeds bun's 5s default and dies at SIGTERM.
// Budget for the real work instead of racing the default.
const INSTALL_TIMEOUT_MS = 30_000;

describe("install stages a clone-independent payload", () => {
  test("copies core/ + shared/ into a versioned application-support payload and points the plist at it", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-payload-"));
    try {
      const { home, env } = makeHome(root);
      const result = await runInstall(["--adapter", "none"], env);
      expect(result.exitCode).toBe(0);

      const payload = join(home, PAYLOAD_REL);
      const verDir = join(payload, "versions", version);
      const current = join(payload, "current");

      // The payload is a real, self-contained COPY (not a symlink back to the clone).
      expect(statSync(join(verDir, "core")).isDirectory()).toBe(true);
      expect(existsSync(join(verDir, "core", "server.ts"))).toBe(true);
      expect(existsSync(join(verDir, "core", "voices.json"))).toBe(true);
      // core/server.ts imports ../shared/echo-env — the sibling layout must be preserved.
      expect(existsSync(join(verDir, "shared", "echo-env.ts"))).toBe(true);

      // `current` is a symlink resolving to the active version.
      expect(lstatSync(current).isSymbolicLink()).toBe(true);
      expect(readlinkSync(current)).toBe(verDir);

      // manifest records the staged version.
      const manifest = JSON.parse(readFileSync(join(verDir, "manifest.json"), "utf8"));
      expect(manifest.version).toBe(version);
      expect(manifest.service).toBe("com.echo");

      // The LaunchAgent runs the payload, NOT the checkout — the survives-repo-removal guarantee.
      const plist = readFileSync(join(home, "Library/LaunchAgents/com.echo.plist"), "utf8");
      expect(plist).toContain(join(current, "core/server.ts"));
      expect(plist).not.toContain(join(REPO_ROOT, "core/server.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, INSTALL_TIMEOUT_MS);

  test("re-staging the same version is idempotent (exit 0, current still resolves)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-payload-idem-"));
    try {
      const { home, env } = makeHome(root);
      const first = await runInstall(["--adapter", "none"], env);
      expect(first.exitCode).toBe(0);
      const second = await runInstall(["--adapter", "none"], env);
      expect(second.exitCode).toBe(0);

      const current = join(home, PAYLOAD_REL, "current");
      expect(readlinkSync(current)).toBe(join(home, PAYLOAD_REL, "versions", version));
      expect(existsSync(join(current, "core", "server.ts"))).toBe(true);

      // --check is clean after install: the plist's payload path is alive.
      const check = await runInstall(["--check"], env);
      expect(check.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, INSTALL_TIMEOUT_MS);

  test("--check flags a removed payload as a dead plist path", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-payload-removed-"));
    try {
      const { home, env } = makeHome(root);
      expect((await runInstall(["--adapter", "none"], env)).exitCode).toBe(0);

      // Simulate the payload being deleted out from under the service.
      rmSync(join(home, PAYLOAD_REL), { recursive: true, force: true });

      const check = await runInstall(["--check"], env);
      expect(check.exitCode).toBe(3);
      expect(check.stderr).toContain("Stale paths found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, INSTALL_TIMEOUT_MS);

  test("an unhealthy reload restores the payload that was running and reports it honestly", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-payload-rollback-"));
    try {
      const { home, env } = makeHome(root);
      const healthyFlag = join(root, "healthy");
      // curl answers only while the flag file exists, so health can be revoked
      // between the two installs without touching anything else.
      writeExecutable(
        join(root, "bin", "curl"),
        `#!/bin/bash\n[ -f ${JSON.stringify(healthyFlag)} ] && exit 0\nexit 7\n`,
      );
      writeFileSync(healthyFlag, "");

      expect((await runInstall(["--adapter", "none"], env)).exitCode).toBe(0);
      const payload = join(home, PAYLOAD_REL);
      const current = join(payload, "current");
      // Marks the copy that is live now; the re-stage must not destroy it.
      writeFileSync(join(current, "sentinel.txt"), "live");

      rmSync(healthyFlag);
      const failed = await runInstall(["--adapter", "none"], env);
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain("Rolling back payload");
      // The restore could not be proven, so it must not claim it was.
      expect(failed.stderr).toContain("ROLLBACK INCOMPLETE");
      expect(failed.stderr).not.toContain("Restored the payload that was running");

      // `current` resolves to the copy that was live, entrypoint and all.
      expect(existsSync(join(current, "sentinel.txt"))).toBe(true);
      expect(existsSync(join(current, "core", "server.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, INSTALL_TIMEOUT_MS);
});
