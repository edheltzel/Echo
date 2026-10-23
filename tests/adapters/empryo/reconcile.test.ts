import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const reconcile = join(import.meta.dir, "../../../adapters/empryo/reconcile.ts");
const dirs: string[] = [];

function run(hooksFile: string, ...args: string[]) {
  return spawnSync("bun", ["run", reconcile, ...args], {
    env: { ...process.env, ECHO_EMPRYO_HOOKS_FILE: hooksFile },
    encoding: "utf8",
  });
}

function commands(doc: any, event: string): string[] {
  return (doc.hooks[event] ?? []).flatMap((group: any) => group.hooks.map((hook: any) => hook.command));
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "echo-empryo-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Empryo reconcile", () => {
  test("registers SessionStart, Stop and Notification without touching sibling hooks", () => {
    const hooksFile = join(scratch(), "hooks.json");
    writeFileSync(hooksFile, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign-stop" }] }] },
      disableAllHooks: false,
    }));
    expect(run(hooksFile, "--check").status).toBe(3);
    expect(run(hooksFile).status).toBe(0);
    const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(doc.disableAllHooks).toBe(false);
    expect(commands(doc, "Stop")).toContain("echo foreign-stop");
    for (const event of ["SessionStart", "Stop", "Notification"]) {
      expect(commands(doc, event).filter((c) => c.includes("adapters/empryo/hook.ts"))).toHaveLength(1);
    }
    expect(run(hooksFile, "--check").status).toBe(0);
    expect(run(hooksFile).stdout).toContain("already current");
  });

  test("rewrites a stale clone path and prunes duplicates", () => {
    const hooksFile = join(scratch(), "hooks.json");
    const stale = "bun '/old/clone/adapters/empryo/hook.ts'";
    writeFileSync(hooksFile, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: stale }] }, { hooks: [{ type: "command", command: stale }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: stale }] }],
      },
    }));
    expect(run(hooksFile).status).toBe(0);
    const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
    expect(commands(doc, "Stop")).toHaveLength(1);
    expect(commands(doc, "Stop")[0]).not.toContain("/old/clone/");
    expect(doc.hooks.PreToolUse).toBeUndefined();
  });

  test("edits a symlinked hooks file at its target", () => {
    const dir = scratch();
    const target = join(dir, "real-hooks.json");
    const link = join(dir, "hooks.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, link);
    expect(run(link).status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(commands(JSON.parse(readFileSync(target, "utf8")), "Stop")).toHaveLength(1);
  });

  test("links $echo-mute and $echo-mode into the skills folder beside the hooks file", () => {
    const dir = scratch();
    const hooksFile = join(dir, "hooks.json");
    expect(run(hooksFile).status).toBe(0);
    for (const name of ["echo-mute", "echo-mode"]) {
      const link = join(dir, "skills", name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(import.meta.dir, "../../../adapters/empryo/skills", name)));
    }
    expect(run(hooksFile, "--check").status).toBe(0);
    rmSync(join(dir, "skills", "echo-mode"));
    expect(run(hooksFile, "--check").status).toBe(3);
  });

  test("refuses to replace a skill folder Echo does not own", () => {
    const dir = scratch();
    const hooksFile = join(dir, "hooks.json");
    mkdirSync(join(dir, "skills", "echo-mute"), { recursive: true });
    writeFileSync(join(dir, "skills", "echo-mute", "SKILL.md"), "mine\n");
    expect(run(hooksFile).status).toBe(2);
    expect(readFileSync(join(dir, "skills", "echo-mute", "SKILL.md"), "utf8")).toBe("mine\n");
  });

  test("invalid JSON is fatal and left untouched", () => {
    const hooksFile = join(scratch(), "hooks.json");
    writeFileSync(hooksFile, "{ not json");
    expect(run(hooksFile).status).toBe(2);
    expect(readFileSync(hooksFile, "utf8")).toBe("{ not json");
  });
});
