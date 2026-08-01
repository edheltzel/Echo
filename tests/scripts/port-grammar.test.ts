import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBoundedInt } from "../../core/env";
import { loadEchoConfigurationWithStatus } from "../../shared/echo-env";

// Differential test over the ONE thing three independent readers must agree on:
// which port a config.json names. The daemon resolves it in TypeScript, and
// cli/echo, the lifecycle scripts and install.sh's health probe resolve it in
// pure bash with a sed capture - so a spelling the two read differently puts the
// daemon on one port while every CLI surface reports it down, permanently.
//
// Each round of review found a different input where two readers disagreed
// (0x0C9E, a leading zero, padding inside the quotes). This table is where the
// next one becomes a test failure instead: add the spelling, and both readers
// have to answer the same.

// Mirrors core/server.ts's `parseBoundedInt(resolveEchoEnv("PORT"), 3246, 0, 65535)`,
// which tests/core/server-contract-source.test.ts pins to that exact expression.
function daemonPort(home: string): number {
  const resolved = loadEchoConfigurationWithStatus({}, home).env.PORT;
  return parseBoundedInt(resolved, 3246, 0, 65535);
}

async function cliPort(home: string): Promise<string> {
  const proc = Bun.spawn(["/bin/bash", "-c", '. scripts/echo-port.sh; echo "$ECHO_PORT"'], {
    env: { HOME: home, PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return stdout.trim();
}

const CASES: { body: string; label: string; port: number }[] = [
  { label: "JSON number", body: '{"PORT": 3457}', port: 3457 },
  { label: "quoted decimal", body: '{"PORT": "3457"}', port: 3457 },
  { label: "lowest valid", body: '{"PORT": 1}', port: 1 },
  { label: "highest valid", body: '{"PORT": 65535}', port: 65535 },

  // Padding: the shell reader takes the value whole and cannot trim.
  { label: "padded both sides", body: '{"PORT": " 3457 "}', port: 3246 },
  { label: "padded trailing", body: '{"PORT": "3457 "}', port: 3246 },
  { label: "padded leading", body: '{"PORT": " 3457"}', port: 3246 },
  { label: "tab padded", body: '{"PORT": "\\t3457"}', port: 3246 },

  // Radix and exponent spellings: Number(), parseInt(_, 10) and bash arithmetic
  // each read these differently.
  { label: "hex", body: '{"PORT": "0x0C9E"}', port: 3246 },
  { label: "binary", body: '{"PORT": "0b1100100"}', port: 3246 },
  { label: "octal literal", body: '{"PORT": "0o6246"}', port: 3246 },
  { label: "exponent", body: '{"PORT": "1e4"}', port: 3246 },
  { label: "leading zero (octal to bash)", body: '{"PORT": "03246"}', port: 3246 },
  { label: "explicit sign", body: '{"PORT": "+3457"}', port: 3246 },
  { label: "fractional string", body: '{"PORT": "3457.5"}', port: 3246 },
  { label: "fractional number", body: '{"PORT": 3457.5}', port: 3246 },

  // Out of range and non-numeric.
  { label: "zero number", body: '{"PORT": 0}', port: 3246 },
  { label: "zero string", body: '{"PORT": "0"}', port: 3246 },
  { label: "above ceiling", body: '{"PORT": 65536}', port: 3246 },
  { label: "far above ceiling", body: '{"PORT": 99999}', port: 3246 },
  { label: "negative", body: '{"PORT": -1}', port: 3246 },
  { label: "boolean", body: '{"PORT": true}', port: 3246 },
  { label: "empty string", body: '{"PORT": ""}', port: 3246 },
  { label: "non-numeric", body: '{"PORT": "abc"}', port: 3246 },

  // Placement: the shell reader is a line-oriented regex, so where the key sits
  // in the document is part of the grammar.
  { label: "absent", body: '{"ECHO_DEFAULT_TITLE": "x"}', port: 3246 },
  { label: "after another key, one line", body: '{"ECHO_DEFAULT_TITLE": "First", "PORT": 3457}', port: 3457 },
  { label: "before another key, one line", body: '{"PORT": 3457, "ECHO_DEFAULT_TITLE": "Last"}', port: 3457 },
  {
    label: "last property, no trailing comma",
    body: '{\n  "ECHO_DEFAULT_TITLE": "First",\n  "PORT": 3457\n}\n',
    port: 3457,
  },
  {
    label: "first property, pretty printed",
    body: '{\n  "PORT": "8888",\n  "ECHO_VOICE_PERSONA_NAME": "Atlas"\n}\n',
    port: 8888,
  },
];

describe("config.json PORT grammar - the daemon and the shell readers agree", () => {
  test.each(CASES)("$label", async ({ body, port }) => {
    const home = mkdtempSync(join(tmpdir(), "echo-port-grammar-"));
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(join(home, ".config", "echo", "config.json"), body);

      const fromDaemon = daemonPort(home);
      const fromCli = await cliPort(home);

      expect(fromDaemon).toBe(port);
      expect(fromCli).toBe(String(port));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ECHO_CONFIG_FILE redirects the shell reader for isolated tests", async () => {
    const home = mkdtempSync(join(tmpdir(), "echo-port-selector-home-"));
    const scratch = mkdtempSync(join(tmpdir(), "echo-port-selector-config-"));
    const configFile = join(scratch, "config.json");
    try {
      writeFileSync(configFile, '{"PORT": 3458}');
      const proc = Bun.spawn(["/bin/bash", "-c", '. scripts/echo-port.sh; echo "$ECHO_PORT"'], {
        env: { HOME: home, PATH: process.env.PATH ?? "", ECHO_CONFIG_FILE: configFile },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);

      expect(exit).toBe(0);
      expect(stdout.trim()).toBe("3458");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("config.json wins over deprecated PORT and the shell warns", async () => {
    const home = mkdtempSync(join(tmpdir(), "echo-port-precedence-"));
    try {
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      writeFileSync(join(home, ".config", "echo", "config.json"), '{"PORT": 3457}');
      const proc = Bun.spawn(["/bin/bash", "-c", '. scripts/echo-port.sh; echo "$ECHO_PORT"'], {
        env: { HOME: home, PATH: process.env.PATH ?? "", PORT: "4567" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(exit).toBe(0);
      expect(stdout.trim()).toBe("3457");
      expect(stderr).toContain("PORT environment configuration is deprecated");
      expect(stderr).toContain("config.json takes precedence");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("deprecated PORT remains a warning fallback when config.json has no port", async () => {
    const home = mkdtempSync(join(tmpdir(), "echo-port-fallback-"));
    try {
      const proc = Bun.spawn(["/bin/bash", "-c", '. scripts/echo-port.sh; echo "$ECHO_PORT"'], {
        env: { HOME: home, PATH: process.env.PATH ?? "", PORT: "4567" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

      expect(exit).toBe(0);
      expect(stdout.trim()).toBe("4567");
      expect(stderr).toContain("PORT environment configuration is deprecated");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
