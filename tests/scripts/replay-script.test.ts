import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "scripts/replay.sh";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runReplay(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", SCRIPT, ...args], {
    env,
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

describe("scripts/replay.sh", () => {
  test("default n=1 and n=3 POST /replay via stub curl", async () => {
    const root = mkdtempSync(join(tmpdir(), "replay-sh-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const log = join(root, "curl-args.log");
      writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\necho '{"status":"accepted","replayed":1}'\nexit 0\n`);
      const env = { HOME: join(root, "home"), PATH: `${bin}:/bin:/usr/bin` };

      expect((await runReplay([], env)).exitCode).toBe(0);
      expect((await runReplay(["3"], env)).exitCode).toBe(0);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain("/replay");
      expect(logged).toContain('"n": 1');
      expect(logged).toContain('"n": 3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects 0, 11, and non-integers with usage (no curl)", async () => {
    const root = mkdtempSync(join(tmpdir(), "replay-sh-bad-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const log = join(root, "curl-args.log");
      writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
      const env = { HOME: join(root, "home"), PATH: `${bin}:/bin:/usr/bin` };

      expect((await runReplay(["0"], env)).exitCode).toBe(2);
      expect((await runReplay(["11"], env)).exitCode).toBe(2);
      expect((await runReplay(["01"], env)).exitCode).toBe(2);
      const bad = await runReplay(["soon"], env);
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr.toLowerCase()).toContain("usage");
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("daemon down → clear error, non-zero exit", async () => {
    const result = await runReplay(["status"], { ...process.env, PORT: "1" });
    // "status" is not a valid n, so usage fires before curl. Probe port 1 with n=1:
    const down = await runReplay(["1"], { ...process.env, PORT: "1" });
    expect(down.exitCode).not.toBe(0);
    expect(down.stderr).toContain("not reachable");
    expect(result.exitCode).toBe(2);
  });
});
