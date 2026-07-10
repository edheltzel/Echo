import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EchoEnvironment = Record<string, string | undefined>;

/**
 * Load Echo's user-owned environment files into `env` without overriding values.
 * Earlier files win per key, matching the daemon's established precedence.
 */
export function loadEchoEnvironment(
  env: EchoEnvironment = { ...process.env },
  homeDir: string = homedir(),
): EchoEnvironment {
  const envPaths = [
    ...((env.ECHO_ENV_PATHS ?? env.VOICESYSTEM_ENV_PATHS)?.split(":").filter(Boolean) ?? []),
    join(homeDir, ".config", "echo", ".env"),
    join(homeDir, ".config", "voicesystem", ".env"),
    join(homeDir, ".env"),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;

      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key && value && !key.startsWith("#") && !env[key]) {
        env[key] = value;
      }
    }
  }

  return env;
}
