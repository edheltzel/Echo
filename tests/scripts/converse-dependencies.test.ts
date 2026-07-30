import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/converse-dependencies.sh");

function executable(path: string): void {
  writeFileSync(path, "#!/bin/bash\nexit 0\n");
  chmodSync(path, 0o755);
}

async function run(env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("echo-converse dependency preflight", () => {
  test("names missing sox and its actionable recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-converse-deps-missing-"));
    try {
      const result = await run({ PATH: `${root}:/bin:/usr/bin` });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing echo-converse dependency: sox");
      expect(result.stderr).toContain("brew install sox");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("names a missing rec when sox is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-converse-deps-rec-"));
    try {
      const sox = join(root, "configured-sox");
      executable(sox);
      const result = await run({ PATH: `${root}:/bin:/usr/bin`, ECHO_CONVERSE_SOX_BIN: sox });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Missing echo-converse dependency: rec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors configured binary overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-converse-deps-configured-"));
    try {
      const sox = join(root, "configured-sox");
      const rec = join(root, "configured-rec");
      executable(sox);
      executable(rec);
      const result = await run({
        PATH: `${root}:/bin:/usr/bin`,
        ECHO_CONVERSE_SOX_BIN: sox,
        ECHO_CONVERSE_REC_BIN: rec,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`sox → ${sox}`);
      expect(result.stdout).toContain(`rec → ${rec}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
