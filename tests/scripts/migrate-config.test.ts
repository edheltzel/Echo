import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/migrate-config.ts drains legacy dotenv Echo settings into config.json
// so an upgrading user keeps their configuration — and, for PORT, so the daemon
// and every bash surface read it from the same place. Each run uses a temp HOME;
// nothing here touches the operator's real config.

async function runMigration(home: string) {
  const proc = Bun.spawn(["bun", "run", "scripts/migrate-config.ts"], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
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

function withHome(prefix: string, fn: (home: string, configDir: string) => Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), prefix));
    const configDir = join(home, ".config", "echo");
    mkdirSync(configDir, { recursive: true });
    try {
      await fn(home, configDir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };
}

describe("scripts/migrate-config.ts", () => {
  test(
    "moves canonical dotenv settings into config.json and reports them",
    withHome("echo-migrate-", async (home, configDir) => {
      writeFileSync(
        join(configDir, ".env"),
        [
          "PORT=8888",
          'ECHO_VOICE_PERSONA_NAME="Atlas"',
          "ELEVENLABS_API_KEY=sk_secret",
          "VOICESYSTEM_DEFAULT_TITLE=Retired",
          "PAI_DIR=/somewhere",
        ].join("\n") + "\n",
      );

      const r = await runMigration(home);
      expect(r.exitCode).toBe(0);

      const written = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
      expect(written.PORT).toBe("8888");
      expect(written.ECHO_VOICE_PERSONA_NAME).toBe("Atlas");
      // The secret, the retired alias, and host-owned context never move: each
      // would make config.json fail the daemon's own validation.
      expect(written.ELEVENLABS_API_KEY).toBeUndefined();
      expect(written.VOICESYSTEM_DEFAULT_TITLE).toBeUndefined();
      expect(written.PAI_DIR).toBeUndefined();

      expect(r.stdout).toContain("PORT");
      expect(r.stdout).toContain("ELEVENLABS_API_KEY");
      // The dotenv file is the permanent home of the secret — say so, and leave it.
      expect(r.stdout).toContain("Do not delete");
      expect(existsSync(join(configDir, ".env"))).toBe(true);
    }),
  );

  test(
    "never overwrites an existing config.json value and is idempotent",
    withHome("echo-migrate-existing-", async (home, configDir) => {
      writeFileSync(join(configDir, ".env"), "PORT=8888\nECHO_DEFAULT_TITLE=From dotenv\n");
      writeFileSync(join(configDir, "config.json"), JSON.stringify({ PORT: 3246 }));

      expect((await runMigration(home)).exitCode).toBe(0);
      const first = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
      expect(first.PORT).toBe(3246);
      expect(first.ECHO_DEFAULT_TITLE).toBe("From dotenv");

      // An already-migrated install stays silent on every later reinstall.
      const second = await runMigration(home);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toBe("");
      expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toEqual(first);
    }),
  );

  test(
    "leaves an unusable config.json alone instead of failing the install",
    withHome("echo-migrate-broken-", async (home, configDir) => {
      writeFileSync(join(configDir, ".env"), "ECHO_DEFAULT_TITLE=From dotenv\n");
      writeFileSync(join(configDir, "config.json"), "{ not json");

      const r = await runMigration(home);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("Skipping config migration");
      expect(readFileSync(join(configDir, "config.json"), "utf8")).toBe("{ not json");
    }),
  );

  // install.sh runs this in preflight under `set -euo pipefail`, so an unreadable
  // config.json has to report and step aside — a throw here fails the install.
  test(
    "reports and skips when config.json cannot be read",
    withHome("echo-migrate-unreadable-", async (home, configDir) => {
      writeFileSync(join(configDir, ".env"), "ECHO_DEFAULT_TITLE=From dotenv\n");
      const configFile = join(configDir, "config.json");
      writeFileSync(configFile, JSON.stringify({ PORT: 3246 }));
      chmodSync(configFile, 0o000);

      try {
        const r = await runMigration(home);
        expect(r.exitCode).toBe(0);
        expect(r.stderr).toContain("Skipping config migration");
        expect(r.stderr).toContain("could not be read");
      } finally {
        chmodSync(configFile, 0o600);
      }
    }),
  );

  // Quote stripping keeps padding inside the quotes, and the JSON port grammar
  // accepts none — migrating verbatim would drop the port the user had.
  test(
    "migrates a padded dotenv PORT into a canonical config value",
    withHome("echo-migrate-padded-port-", async (home, configDir) => {
      writeFileSync(join(configDir, ".env"), 'PORT=" 8888 "\nECHO_VOICE_CATCHPHRASE=" spaced "\n');

      const r = await runMigration(home);
      expect(r.exitCode).toBe(0);

      const written = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
      expect(written.PORT).toBe("8888");
      // Only PORT is normalized; every other value migrates byte for byte.
      expect(written.ECHO_VOICE_CATCHPHRASE).toBe(" spaced ");
    }),
  );

  // Naming the wrong file is how the user deletes the one the daemon reads the
  // key from — the exact outcome this notice exists to prevent.
  test(
    "names the file the secret actually lives in",
    withHome("echo-migrate-secret-source-", async (home, configDir) => {
      const voicesystemDir = join(home, ".config", "voicesystem");
      mkdirSync(voicesystemDir, { recursive: true });
      writeFileSync(join(configDir, ".env"), "ECHO_DEFAULT_TITLE=From echo\n");
      writeFileSync(join(voicesystemDir, ".env"), "ELEVENLABS_API_KEY=sk_secret\n");

      const r = await runMigration(home);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain(`ELEVENLABS_API_KEY stays in ${join(voicesystemDir, ".env")}`);
      expect(r.stdout).not.toContain(`stays in ${join(configDir, ".env")}`);
    }),
  );

  test(
    "does nothing when there is no legacy dotenv file",
    withHome("echo-migrate-none-", async (home, configDir) => {
      const r = await runMigration(home);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("");
      expect(existsSync(join(configDir, "config.json"))).toBe(false);
    }),
  );

  // ~/.env is a shared user dotfile, so it is never rewritten — but a PORT there
  // used to move the daemon and no longer does, which is exactly the silent
  // behavior change an upgrade must not make.
  test(
    "names a PORT in ~/.env instead of moving the daemon silently",
    withHome("echo-migrate-home-env-", async (home, configDir) => {
      writeFileSync(join(home, ".env"), "PORT=8888\n");

      const r = await runMigration(home);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("PORT=8888");
      expect(r.stdout).toContain("no longer honored");
      expect(r.stdout).toContain(join(home, ".env"));
      expect(readFileSync(join(home, ".env"), "utf8")).toBe("PORT=8888\n");
      expect(existsSync(join(configDir, "config.json"))).toBe(false);
    }),
  );
});
