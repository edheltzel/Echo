// Output mode: `speech` (default) speaks notifications; `sounds` plays the
// notification's slot sound instead. One global setting, persisted beside
// mute.json so it survives a daemon restart and is read on every dequeue, the
// same way mute is. Kept in its own file because mute writes replace mute.json
// whole. Reads are tolerant: a missing or malformed file means `speech`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveMuteStatePath, writeStateFile } from "./mute";
import { resolveEchoEnv } from "./env";

export const OUTPUT_MODES = ["speech", "sounds"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export function isOutputMode(value: unknown): value is OutputMode {
  return value === "speech" || value === "sounds";
}

export function resolveOutputModePath(): string {
  return resolveEchoEnv("ECHO_MODE_STATE_PATH") ?? join(dirname(resolveMuteStatePath()), "mode.json");
}

export function readOutputMode(path: string = resolveOutputModePath()): OutputMode {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isOutputMode(parsed?.mode) ? parsed.mode : "speech";
  } catch {
    return "speech";
  }
}

export function writeOutputMode(mode: OutputMode, path: string = resolveOutputModePath()): void {
  writeStateFile(path, { mode });
}
