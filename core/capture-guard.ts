// =============================================================================
// Capture guard - hold speech while an external process captures the mic
// =============================================================================
//
// When a voice-input tool (VoiceLayer's VoiceBar) has the microphone open,
// Echo's TTS playing into that capture pollutes the user's recording. The
// capture tool publishes a cross-process state file for exactly this purpose
// ("lets speaker output gates see VoiceBar captures"); Echo reads it at speak
// time and skips the voice line - mute-style - while a capture is live. The
// banner is unaffected (it fires at accept, and it is not audio).
//
// Contract of the state file (written by the capture tool, mode 0600):
//   { "state": "idle" | "recording" | "transcribing", "pid": <writer pid>,
//     "updated_at": "<ISO timestamp>", "nonce": "<optional owner secret>" }
// A non-idle state only counts when the writing pid is still alive - a crashed
// capture session's stale file must never silence Echo forever. This mirrors
// the writer's own reader semantics.
//
// `nonce` is optional and additive: a writer that omits it (VoiceLayer's
// VoiceBar) behaves exactly as before. A writer that includes it can present the
// same value on POST /notify to speak into its OWN hold, which is what lets a
// voice ask say its question without a gap between "question finished" and
// "microphone open" for another session's audio to slip into.
//
// Reads are tolerant, mirroring core/mute.ts: a missing, corrupt, or
// wrong-shaped file means idle, never a crash. Echo never writes this file.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEchoEnv } from "./env";

export type CaptureState = "idle" | "recording" | "transcribing";

const CAPTURE_STATES: readonly CaptureState[] = ["idle", "recording", "transcribing"];

// ECHO_CAPTURE_STATE_PATH: unset → the capture tool's published default
// (VoiceLayer hardcodes ~/.local/state with no XDG consult - match the
// writer, not the XDG convention); empty string → guard disabled entirely.
// Resolved at call time (not frozen at module load), like the mute path.
export function resolveCaptureStatePath(): string | null {
  const env = resolveEchoEnv("ECHO_CAPTURE_STATE_PATH");
  if (env !== undefined) return env === "" ? null : env;
  return join(homedir(), ".local", "state", "voicelayer", "recording-state.json");
}

// Same liveness semantics as the state file's writer: signal 0 probes the
// pid. An EPERM (foreign-user process) reads as dead - same-user processes
// make that moot in practice, and matching the writer keeps one contract.
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A live capture, as published by whoever holds the microphone.
 *
 * `nonce` is the capture owner's per-turn secret. It exists so the owner can ask
 * to speak INTO its own hold (a voice ask has to say the question while the hold
 * is already up, or another session's audio could start in the gap before the
 * microphone opens). The file is 0600, so knowing the nonce is proof of being
 * the owner or of already having the operator's read access. The pid is NOT
 * usable for that: it is readable by anyone who can stat the file, and treating
 * it as authorization would let any local process speak into a recording.
 */
export interface CaptureRecord {
  state: Exclude<CaptureState, "idle">;
  pid: number;
  nonce?: string;
}

/**
 * The live capture, or null when nothing is capturing. Same tolerant reads and
 * same stale-crash guard as `readCaptureState`, which is defined in terms of it.
 */
export function readCaptureRecord(
  path: string | null = resolveCaptureStatePath(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): CaptureRecord | null {
  if (path === null) return null; // guard disabled

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null; // no capture tool on this machine / nothing captured yet
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt file = idle, never a crash
  }

  if (
    typeof parsed !== "object" || parsed === null ||
    !CAPTURE_STATES.includes(parsed.state) ||
    typeof parsed.pid !== "number" ||
    typeof parsed.updated_at !== "string"
  ) {
    return null; // wrong shape = idle
  }

  if (parsed.state === "idle") return null;

  // Stale-crash guard: a non-idle state from a dead writer is idle.
  if (!isPidAlive(parsed.pid)) return null;

  return {
    state: parsed.state,
    pid: parsed.pid,
    nonce: typeof parsed.nonce === "string" && parsed.nonce.length > 0 ? parsed.nonce : undefined,
  };
}

export function readCaptureState(
  path: string | null = resolveCaptureStatePath(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): CaptureState {
  return readCaptureRecord(path, isPidAlive)?.state ?? "idle";
}

/** True while an external mic capture is live (recording or transcribing). */
export function isCaptureActive(path?: string | null): boolean {
  return readCaptureState(path) !== "idle";
}
