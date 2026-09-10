// Cross-process stop token for an in-flight echo_ask recording.
//
// Capture lives in the caller (TCC); the coordinator never opens the microphone.
// A user-owned file is the smallest signal both sides already know how to share:
// the booking lock lives next to it under ~/.local/state/echo/converse/. Touching
// the file (or POST /turn/:id/stop, which writes the same path) SIGTERMs the
// recorder. That ends capture early and still transcribes: it is not a cancel.

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function requestStop(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "", { mode: 0o600 });
}

export function clearStopSignal(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** True when a stop was pending. Consuming clears the file so the next turn is not immediately stopped. */
export function consumeStopSignal(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
