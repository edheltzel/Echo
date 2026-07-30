// Writer for the cross-process capture-state contract that core/capture-guard.ts
// reads.
//
// Core has always been a reader of this file: while some other tool holds the
// microphone, core skips its voice lines so its own speech never lands in the
// human's recording. Converse becomes the writer, which turns the arbitration
// core already ships into the interlock a conversation needs, in reverse and for
// free.
//
// Three rules follow from that, and all three are load-bearing:
//
//  1. Only the process that actually holds the capture writes this file, with
//     its OWN pid. Core honors a non-idle state only while that pid is alive, so
//     writing someone else's pid would turn a crash into permanent silence for
//     the operator. The capture child's parent is the owner; it writes, and it
//     clears in a `finally`.
//  2. The hold goes up BEFORE the question is spoken, which is what leaves no
//     gap between "the question finished" and "the microphone opened" for
//     another session's audio to start in. The question stays audible because it
//     carries the per-turn nonce from this same file, which core accepts as
//     proof that the line belongs to the process holding the microphone.
//  3. Because of rule 2 the hold is published before the booking race has been
//     resolved, so BOTH writes compare against the record on disk first. A
//     publish never overwrites a live foreign hold, and the clear only writes
//     `idle` over a record that is ours. Without that, two asks racing would
//     each stamp their pid over the other: the loser's `finally` would clear the
//     winner's live hold and core would speak into an in-progress recording.
//     The compare is a read-then-write, not an atomic swap - the booking lock is
//     what actually serializes two coordinators; this keeps a losing caller from
//     damaging the winner's record on the way to its own 409.
//
// The path is never guessed: core reports the file it actually reads through
// GET /health (`capture_guard.path`), and converse writes exactly that.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type { CaptureState } from "./types.ts";
import type { CaptureState } from "./types.ts";

export interface CaptureStateRecord {
  state: CaptureState;
  pid: number;
  updated_at: string;
  /**
   * The owner's per-turn secret. Core accepts it on POST /notify as proof that a
   * line belongs to the process holding the microphone, which is what lets a
   * voice ask speak its question into its own hold. The file is 0600.
   */
  nonce?: string;
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
  nonce?: string,
): CaptureStateRecord {
  const record: CaptureStateRecord = { state, pid, updated_at: new Date(now).toISOString() };
  // Only published while a hold is up. An idle record carries no secret, so a
  // stale file can never be replayed as a bypass credential.
  if (nonce !== undefined && state !== "idle") record.nonce = nonce;
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

export type PidProbe = (pid: number) => boolean;

/** Signal 0 probes the pid; EPERM reads as dead, exactly as core's guard does. */
const defaultIsPidAlive: PidProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Tolerant read: missing, unreadable, corrupt or wrong-shaped all read as "no
 * usable record", which is the same reading core gives such a file.
 */
export function readCaptureState(path: string): CaptureStateRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const state = record.state;
    if (state !== "idle" && state !== "recording" && state !== "transcribing") return null;
    if (typeof record.pid !== "number" || !Number.isFinite(record.pid)) return null;
    return {
      state,
      pid: record.pid,
      updated_at: typeof record.updated_at === "string" ? record.updated_at : "",
      ...(typeof record.nonce === "string" ? { nonce: record.nonce } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * True when the record on disk is a LIVE hold belonging to another TURN.
 *
 * Identity is the pid AND the per-turn nonce, not the pid alone. One host
 * process can have two asks in flight (an MCP stdio server serving parallel tool
 * calls is the obvious case), and they share a pid: matching on pid alone would
 * let the second ask overwrite the first one's record and then clear it, which
 * is the defect this compare exists to close. A dead owner's record is not a
 * hold at all - core ignores it too - so it never blocks a publish.
 */
export function holdIsForeign(
  record: CaptureStateRecord | null,
  pid: number,
  nonce?: string,
  isPidAlive: PidProbe = defaultIsPidAlive,
): boolean {
  if (record === null || record.state === "idle") return false;
  if (!isPidAlive(record.pid)) return false;
  if (record.pid !== pid) return true;
  return nonce !== undefined && record.nonce !== nonce;
}

/**
 * Publish a hold, unless a live foreign one is already up.
 *
 * Declining rather than overwriting is the point: the loser of a booking race
 * must not stamp itself over the winner's record, or the winner's own preflight
 * would then read the hold as foreign and refuse the turn it just won.
 */
export function publishCaptureHold(
  path: string,
  state: CaptureState,
  pid: number = process.pid,
  nonce?: string,
  isPidAlive: PidProbe = defaultIsPidAlive,
): boolean {
  if (state !== "idle" && holdIsForeign(readCaptureState(path), pid, nonce, isPidAlive)) return false;
  writeCaptureState(path, state, pid, Date.now(), nonce);
  return true;
}

/** A hold that could not be published, because another turn already holds one. */
export class CaptureHoldError extends Error {
  constructor(readonly code: "microphone_busy", message: string) {
    super(message);
    this.name = "CaptureHoldError";
  }
}

/**
 * Clear the hold, but only when the record on disk is ours: same pid, and the
 * same per-turn nonce when one was published. Anything else belongs to another
 * turn, and writing `idle` over it would free core to speak into a recording
 * that is still running.
 */
export function clearCaptureHold(path: string, pid: number = process.pid, nonce?: string): boolean {
  const record = readCaptureState(path);
  if (record === null) return false;
  if (record.pid !== pid) return false;
  if (nonce !== undefined && record.nonce !== nonce) return false;
  writeCaptureState(path, "idle", pid);
  return true;
}

/**
 * Run `body` with the capture state published, and always return to idle.
 *
 * A hold that could not be published fails the turn here rather than running the
 * body anyway. Proceeding without one would leave the recording with no
 * interlock at all if the other turn finished before the coordinator's preflight
 * read the state: core would see idle, grant the turn, and speak into it.
 *
 * The clear always RUNS - if it were skipped on the failure path, a failed
 * transcription would leave core silent until the host process exited - but it
 * only WRITES over our own record.
 */
export async function withCaptureHeld<T>(
  path: string,
  body: (publish: (state: CaptureState) => boolean) => Promise<T>,
  pid: number = process.pid,
  nonce?: string,
  isPidAlive: PidProbe = defaultIsPidAlive,
): Promise<T> {
  const publish = (state: CaptureState) => publishCaptureHold(path, state, pid, nonce, isPidAlive);
  if (!publish("recording")) {
    throw new CaptureHoldError(
      "microphone_busy",
      "another capture already holds the microphone, so this ask published no hold of its own",
    );
  }
  try {
    return await body(publish);
  } finally {
    try {
      clearCaptureHold(path, pid, nonce);
    } catch {
      // Core treats a state file it cannot read as idle, and a dead writer's
      // state as idle too, so a failed clear degrades to silence-free behavior
      // rather than to a permanently muted daemon.
    }
  }
}
