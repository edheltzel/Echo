import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const reconcile = join(import.meta.dir, "../../../adapters/codex/reconcile.ts");

describe("Codex reconcile", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("merges Echo hooks without clobbering siblings", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-codex-"));
    dirs.push(dir);
    const hooksFile = join(dir, "hooks.json");
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "echo foreign-stop", timeout: 5 },
              ],
            },
          ],
        },
      }),
    );

    const r = spawnSync("bun", ["run", reconcile], {
      env: { ...process.env, ECHO_CODEX_HOOKS_FILE: hooksFile },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
    const stopCommands = doc.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCommands.some((c: string) => c.includes("foreign-stop"))).toBe(true);
    expect(stopCommands.some((c: string) => c.includes("adapters/codex/hook.ts"))).toBe(true);

    const muteSkill = join(dir, "skills", "echo-mute");
    expect(readFileSync(join(muteSkill, "SKILL.md"), "utf8")).toContain("bash \"$CLI\" mute");

    const check = spawnSync("bun", ["run", reconcile, "--check"], {
      env: { ...process.env, ECHO_CODEX_HOOKS_FILE: hooksFile },
      encoding: "utf8",
    });
    expect(check.status).toBe(0);
  });

  test("--check reports pending on empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-codex-empty-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const hooksFile = join(dir, "hooks.json");
    writeFileSync(hooksFile, "{}\n");
    const check = spawnSync("bun", ["run", reconcile, "--check"], {
      env: { ...process.env, ECHO_CODEX_HOOKS_FILE: hooksFile },
      encoding: "utf8",
    });
    expect(check.status).toBe(3);
  });
});
