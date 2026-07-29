// Writer for the cross-process capture-state contract that core/capture-guard.ts
// reads.
//
// Core has always been a reader of this file: while some other tool holds the
// microphone, core skips its voice lines so its own speech never lands in the
// human's recording. Converse becomes the writer, which turns the arbitration
// core already ships into the interlock a conversation needs, in reverse and for
// free.
//
// Two rules follow from that, and both are load-bearing:
//
//  1. Only the process that actually holds the capture writes this file, with
//     its OWN pid. Core honors a non-idle state only while that pid is alive, so
//     writing someone else's pid would turn a crash into permanent silence for
//     the operator. The capture child's parent is the owner; it writes, and it
//     clears in a `finally`.
//  2. The write happens only AFTER the question has finished playing. Flipping
//     to `recording` first would make core hold back the very question converse
//     asked it to speak - the self-hold trap. `withCaptureHeld` exists so that
//     ordering is expressed in code rather than remembered.
//
// The path is never guessed: core reports the file it actually reads through
// GET /health (`capture_guard.path`), and converse writes exactly that.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type CaptureState = "idle" | "recording" | "transcribing";

export interface CaptureStateRecord {
  state: CaptureState;
  pid: number;
  updated_at: string;
}

/**
 * Publish a capture state. Written through a temporary file in the same
 * directory and renamed into place, so core can never read a half-written
 * record: a torn read parses as idle, which would let core speak into a live
 * microphone.
 */
export function writeCaptureState(
  path: string,
  state: CaptureState,
  pid: number = process.pid,
  now: number = Date.now(),
): CaptureStateRecord {
  const record: CaptureStateRecord = { state, pid, updated_at: new Date(now).toISOString() };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const staging = join(dirname(path), `.${pid}.capture-state.tmp`);
  writeFileSync(staging, JSON.stringify(record), { mode: 0o600 });
  try {
    renameSync(staging, path);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  return record;
}

/**
 * Run `body` with the capture state published, and always return to idle.
 *
 * The clearing write is unconditional: if it were skipped on the failure path, a
 * failed transcription would leave core silent until the host process exited.
 */
export async function withCaptureHeld<T>(
  path: string,
  body: (publish: (state: CaptureState) => void) => Promise<T>,
  pid: number = process.pid,
): Promise<T> {
  const publish = (state: CaptureState) => void writeCaptureState(path, state, pid);
  publish("recording");
  try {
    return await body(publish);
  } finally {
    try {
      writeCaptureState(path, "idle", pid);
    } catch {
      // Core treats a state file it cannot read as idle, and a dead writer's
      // state as idle too, so a failed clear degrades to silence-free behavior
      // rather than to a permanently muted daemon.
    }
  }
}
