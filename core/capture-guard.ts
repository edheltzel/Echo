// =============================================================================
// Capture guard — hold speech while an external process captures the mic
// =============================================================================
//
// When a voice-input tool (VoiceLayer's VoiceBar) has the microphone open,
// Echo's TTS playing into that capture pollutes the user's recording. The
// capture tool publishes a cross-process state file for exactly this purpose
// ("lets speaker output gates see VoiceBar captures"); Echo reads it at speak
// time and skips the voice line — mute-style — while a capture is live. The
// banner is unaffected (it fires at accept, and it is not audio).
//
// Contract of the state file (written by the capture tool, mode 0600):
//   { "state": "idle" | "recording" | "transcribing", "pid": <writer pid>,
//     "updated_at": "<ISO timestamp>" }
// A non-idle state only counts when the writing pid is still alive — a crashed
// capture session's stale file must never silence Echo forever. This mirrors
// the writer's own reader semantics.
//
// Reads are tolerant, mirroring core/mute.ts: a missing, corrupt, or
// wrong-shaped file means idle, never a crash. Echo never writes this file.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CaptureState = "idle" | "recording" | "transcribing";

const CAPTURE_STATES: readonly CaptureState[] = ["idle", "recording", "transcribing"];

// ECHO_CAPTURE_STATE_PATH: unset → the capture tool's published default
// (VoiceLayer hardcodes ~/.local/state with no XDG consult — match the
// writer, not the XDG convention); empty string → guard disabled entirely.
// Resolved at call time (not frozen at module load), like the mute path.
export function resolveCaptureStatePath(): string | null {
  const env = process.env.ECHO_CAPTURE_STATE_PATH;
  if (env !== undefined) return env === "" ? null : env;
  return join(homedir(), ".local", "state", "voicelayer", "recording-state.json");
}

// Same liveness semantics as the state file's writer: signal 0 probes the
// pid. An EPERM (foreign-user process) reads as dead — same-user processes
// make that moot in practice, and matching the writer keeps one contract.
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readCaptureState(
  path: string | null = resolveCaptureStatePath(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): CaptureState {
  if (path === null) return "idle"; // guard disabled

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return "idle"; // no capture tool on this machine / nothing captured yet
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "idle"; // corrupt file = idle, never a crash
  }

  if (
    typeof parsed !== "object" || parsed === null ||
    !CAPTURE_STATES.includes(parsed.state) ||
    typeof parsed.pid !== "number" ||
    typeof parsed.updated_at !== "string"
  ) {
    return "idle"; // wrong shape = idle
  }

  if (parsed.state === "idle") return "idle";

  // Stale-crash guard: a non-idle state from a dead writer is idle.
  return isPidAlive(parsed.pid) ? parsed.state : "idle";
}

/** True while an external mic capture is live (recording or transcribing). */
export function isCaptureActive(path?: string | null): boolean {
  return readCaptureState(path) !== "idle";
}
