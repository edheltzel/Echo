// =============================================================================
// Playback state - publish idle/speaking for other processes
// =============================================================================
//
// The reverse of core/capture-guard.ts: Echo writes one cross-process signal
// file so a visualizer or another audio tool can poll playback without a UI
// and without a /notify change.
//
//   { "state": "idle" | "speaking", "queue_depth": <n>, "pid": <daemon pid>,
//     "updated_at": "<ISO timestamp>" }
//
// queue_depth is the queued-not-in-flight count (PlayQueue.depth, the same
// number GET /health reports as play_queue.depth). A missing file means idle,
// so nothing is written until the first queue transition.
//
// ECHO_PLAYBACK_STATE_PATH: unset -> ~/.local/state/echo/playback-state.json;
// empty string -> no writes. Hardcoded ~/.local/state, no XDG_STATE_HOME
// consult: this is a published path, and a reader cannot see the writer's
// XDG variable. capture-guard matches its writer's hardcoded path for the
// same reason. Operator-local files (mute.json, the resolution log) do
// consult XDG, and only off macOS.
//
// Readers apply pid-liveness. A dead pid reads as idle (queue_depth 0), so a
// crashed daemon's stale "speaking" cannot linger. Writes are atomic
// (temp + rename), best-effort, and never throw.
// ponytail: sync rename on the caller turn. Detach the write if a wedged
// state dir ever stalls playback.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEchoEnv } from "./env";

export type PlaybackState = "idle" | "speaking";

export interface PlaybackStateRecord {
  state: PlaybackState;
  queue_depth: number;
  pid: number;
  updated_at: string;
}

export interface PlaybackSnapshot {
  state: PlaybackState;
  queue_depth: number;
}

export function resolvePlaybackStatePath(): string | null {
  const env = resolveEchoEnv("ECHO_PLAYBACK_STATE_PATH");
  if (env !== undefined) return env === "" ? null : env;
  return join(homedir(), ".local", "state", "echo", "playback-state.json");
}

// signal 0 probes the pid. EPERM (foreign-user process) reads as dead, matching
// core/capture-guard.ts so both signal files share one liveness contract.
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const IDLE: PlaybackSnapshot = Object.freeze({ state: "idle", queue_depth: 0 });

function isPlaybackRecord(value: unknown): value is PlaybackStateRecord {
  if (typeof value !== "object" || value === null) return false;
  if (!("state" in value) || !("pid" in value) || !("updated_at" in value) || !("queue_depth" in value)) {
    return false;
  }
  const { state, pid, updated_at, queue_depth } = value;
  return (state === "idle" || state === "speaking")
    && typeof pid === "number"
    && Number.isFinite(pid)
    && typeof updated_at === "string"
    && typeof queue_depth === "number"
    && Number.isInteger(queue_depth)
    && queue_depth >= 0;
}

export function readPlaybackState(
  path: string | null = resolvePlaybackStatePath(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): PlaybackSnapshot {
  if (path === null) return IDLE;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return IDLE;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return IDLE;
  }

  if (!isPlaybackRecord(parsed) || !isPidAlive(parsed.pid)) return IDLE;
  return { state: parsed.state, queue_depth: parsed.queue_depth };
}

export function writePlaybackState(
  state: PlaybackState,
  queueDepth: number,
  path: string | null = resolvePlaybackStatePath(),
  pid: number = process.pid,
  now: number = Date.now(),
): void {
  if (path === null) return;

  const staging = join(dirname(path), `.${pid}.playback-state.tmp`);
  try {
    const record: PlaybackStateRecord = {
      state,
      queue_depth: queueDepth,
      pid,
      updated_at: new Date(now).toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(staging, JSON.stringify(record), { mode: 0o600 });
    renameSync(staging, path);
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
      // Cleanup is best-effort too. A leftover temp is not the signal file.
    }
  }
}
