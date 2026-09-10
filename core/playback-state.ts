// =============================================================================
// Playback state - publish Echo's speaker occupancy as a cross-process file
// =============================================================================
//
// Echo already consumes a capture-state file (core/capture-guard.ts). This is
// the reverse direction: the play queue writes a tiny JSON snapshot so a
// visualizer, menu-bar indicator, or VoiceLayer can see whether Echo is mid-
// line without polling HTTP or owning any UI here (#106).
//
// Contract (mode 0600, user-owned path, never /tmp):
//   { "state": "idle" | "speaking", "queue_depth": <queued, not in-flight>,
//     "pid": <writer pid>, "updated_at": "<ISO timestamp>" }
// Readers apply pid-liveness: a speaking snapshot from a dead pid is idle, so
// a crashed daemon cannot look mid-line forever. That matches capture-guard.
//
// Writes are atomic (temp + rename), best-effort, and never throw - the same
// bar as core/audio-log.ts. An empty ECHO_PLAYBACK_STATE_PATH disables
// publishing. Path is resolved at call time, not frozen at import.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEchoEnv } from "./env";

export type PlaybackState = "idle" | "speaking";

export interface PlaybackSignal {
  state: PlaybackState;
  queue_depth: number;
  pid: number;
  updated_at: string;
}

const PLAYBACK_STATES: readonly PlaybackState[] = ["idle", "speaking"];
const IDLE: PlaybackSignal = { state: "idle", queue_depth: 0, pid: 0, updated_at: "" };

// ECHO_PLAYBACK_STATE_PATH: unset → ~/.local/state/echo/playback-state.json
// (XDG-shaped default, matching converse's user-owned state tree; empty
// string → publishing disabled). Resolved at call time, like the mute path.
export function resolvePlaybackStatePath(): string | null {
  const env = resolveEchoEnv("ECHO_PLAYBACK_STATE_PATH");
  if (env !== undefined) return env === "" ? null : env;
  return join(homedir(), ".local", "state", "echo", "playback-state.json");
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writePlaybackState(
  snapshot: { state: PlaybackState; queue_depth: number; pid?: number },
  path: string | null = resolvePlaybackStatePath(),
): void {
  if (path === null || path === "") return;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: PlaybackSignal = {
      state: snapshot.state,
      queue_depth: snapshot.queue_depth,
      pid: snapshot.pid ?? process.pid,
      updated_at: new Date().toISOString(),
    };
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* swallow */ }
  }
}

export function readPlaybackState(
  path: string | null = resolvePlaybackStatePath(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): PlaybackState {
  return readPlaybackSignal(path, isPidAlive).state;
}

export function readPlaybackSignal(
  path: string | null = resolvePlaybackStatePath(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): PlaybackSignal {
  if (path === null || path === "") return { ...IDLE };

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { ...IDLE };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...IDLE };
  }

  if (
    typeof parsed !== "object" || parsed === null ||
    !PLAYBACK_STATES.includes(parsed.state) ||
    typeof parsed.queue_depth !== "number" || !Number.isFinite(parsed.queue_depth) ||
    parsed.queue_depth < 0 ||
    typeof parsed.pid !== "number" ||
    typeof parsed.updated_at !== "string"
  ) {
    return { ...IDLE };
  }

  const signal: PlaybackSignal = {
    state: parsed.state,
    queue_depth: parsed.queue_depth,
    pid: parsed.pid,
    updated_at: parsed.updated_at,
  };

  if (signal.state === "idle") return signal;
  if (isPidAlive(signal.pid)) return signal;
  return { ...signal, state: "idle", queue_depth: 0 };
}
