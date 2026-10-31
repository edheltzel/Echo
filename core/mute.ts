// =============================================================================
// Runtime mute state - host-neutral (issue #83, scoped mute FM-446)
// =============================================================================
//
// Persisted as a tiny JSON file so a daemon restart cannot un-mute the user
// mid-meeting. Timed mutes store an ISO deadline and expire LAZILY at read
// time - no timers, no scheduler; a request arriving after the deadline
// behaves unmuted and the stale file is cleaned up opportunistically. Reads
// are tolerant: a missing, corrupt, or wrong-shaped file means unmuted, never
// a crash. Writes are atomic (temp + rename).
//
// Scopes (role-scoped keys, no migration):
//   tts - speech only: a line with a sound slot plays its notification sound
//         instead (core/server.ts). Notifications still accepted and logged.
//   mic - capture / converse / echo_ask booking paths only. TTS may speak.
//   all - both (the historical mute). Missing scope on a muted file is `all`.
//
// `muted` stays the speech flag: true when scope is tts or all. Mic-only
// stores muted=false with scope=mic so existing /health.mute.muted readers
// still mean "speech is off".

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEchoEnv } from "./env";

export const MUTE_SCOPES = ["tts", "mic", "all"] as const;
export type MuteScope = (typeof MUTE_SCOPES)[number];

export interface MuteState {
  muted: boolean;
  muted_until: string | null; // ISO timestamp; null = indefinite
  scope: MuteScope;
}

const UNMUTED: MuteState = { muted: false, muted_until: null, scope: "all" };

export function isMuteScope(value: unknown): value is MuteScope {
  return value === "tts" || value === "mic" || value === "all";
}

/** Speaker/playback is held. True for `tts` and `all`. */
export function isTtsMuted(state: MuteState = readMuteState()): boolean {
  return state.muted;
}

/**
 * Capture / converse booking is held. True for `mic` and `all`.
 * A legacy `{muted:true}` file (no scope) normalizes to `all`.
 */
export function isMicMuted(state: MuteState = readMuteState()): boolean {
  return state.scope === "mic" || (state.muted && state.scope === "all");
}

// User-owned state path, mirroring the AUDIO_CACHE_DIR precedent (never /tmp).
// Resolved at call time (not frozen at module load) so tests and operators can
// repoint ECHO_MUTE_STATE_PATH without a daemon restart ordering concern.
export function resolveMuteStatePath(): string {
  return resolveEchoEnv("ECHO_MUTE_STATE_PATH") ?? (
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'echo', 'mute.json')
      : join(resolveEchoEnv("XDG_STATE_HOME") || join(homedir(), '.local', 'state'), 'echo', 'mute.json')
  );
}

function activeMute(muted_until: string | null, scope: MuteScope): MuteState {
  if (scope === "mic") return { muted: false, muted_until, scope: "mic" };
  return { muted: true, muted_until, scope };
}

export function readMuteState(path: string = resolveMuteStatePath()): MuteState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { ...UNMUTED }; // missing/unreadable file = unmuted
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`🔇 Mute state file unreadable (${path}) - treating as unmuted`);
    return { ...UNMUTED };
  }

  if (typeof parsed?.muted !== 'boolean') {
    console.warn(`🔇 Mute state file malformed (${path}) - treating as unmuted`);
    return { ...UNMUTED };
  }

  const scope: MuteScope = isMuteScope(parsed.scope) ? parsed.scope : "all";
  // Mic-only is the one active mute that stores muted=false. Anything else
  // with muted=false is unmuted (including a leftover scope:tts/all).
  if (!parsed.muted && scope !== "mic") return { ...UNMUTED };

  // A non-string, non-null deadline (e.g. a hand-edited numeric epoch) is a
  // malformed shape - falling back to "indefinite mute" would turn corruption
  // into the strongest possible mute, inverting the tolerant-read contract.
  if (parsed.muted_until != null && typeof parsed.muted_until !== 'string') {
    console.warn(`🔇 Mute state file malformed (${path}) - treating as unmuted`);
    return { ...UNMUTED };
  }

  const until = typeof parsed.muted_until === 'string' ? parsed.muted_until : null;
  if (until !== null) {
    const deadline = Date.parse(until);
    if (Number.isNaN(deadline)) {
      console.warn(`🔇 Mute deadline unparseable (${path}) - treating as unmuted`);
      return { ...UNMUTED };
    }
    if (deadline <= Date.now()) {
      // Lazy expiry: the timed mute has elapsed. Clean up opportunistically;
      // a failed cleanup is harmless (next read expires it again).
      try { writeMuteState({ ...UNMUTED }, path); } catch {}
      return { ...UNMUTED };
    }
  }

  return activeMute(until, scope);
}

/** Atomic JSON state write (temp + rename): no partial-file window. */
export function writeStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path); // atomic on the same filesystem - no partial-file window
}

export function writeMuteState(state: MuteState, path: string = resolveMuteStatePath()): void {
  writeStateFile(path, state);
}

export function setMuteState(
  muted: boolean,
  durationMinutes?: number,
  path?: string,
  scope: MuteScope = "all",
): MuteState {
  const muted_until = muted && durationMinutes
    ? new Date(Date.now() + durationMinutes * 60_000).toISOString()
    : null;
  const state: MuteState = muted ? activeMute(muted_until, scope) : { ...UNMUTED };
  writeMuteState(state, path);
  return state;
}

export function toggleMuteState(path?: string, scope: MuteScope = "all"): MuteState {
  const current = readMuteState(path);
  // Unscoped toggle keeps today's `!muted` flip: unmuted and all (and tts,
  // which also sets muted) invert the speaker flag. Mic-only has muted=false,
  // so an all-toggle from there becomes all, matching "toggle works as all".
  if (scope === "all") {
    return setMuteState(!current.muted, undefined, path, "all");
  }
  const currentlyOn = scope === "mic"
    ? current.scope === "mic"
    : current.muted && current.scope === "tts";
  return setMuteState(!currentlyOn, undefined, path, scope);
}

// -----------------------------------------------------------------------------
// Absolute mute ("mute until", ATL-ECHO-SNOOZE-DASH-01). Same stored deadline
// as a duration mute: `muted_until` is UTC ISO; display is local. Two inputs,
// one deadline (T3-style snooze).
// -----------------------------------------------------------------------------

/**
 * Validate an absolute `until` value. Returns the deadline as UTC ISO, or
 * throws an `Invalid ...` error (mapped to HTTP 400) when it is not a string,
 * not a parseable ISO 8601 timestamp, or not strictly in the future.
 */
export function parseMuteUntil(value: unknown, now: number = Date.now()): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Invalid body: 'until' must be an ISO 8601 timestamp");
  }
  // Require a date + time shape; Date.parse alone accepts loose strings.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim())) {
    throw new Error("Invalid body: 'until' must be an ISO 8601 timestamp");
  }
  const deadline = Date.parse(value);
  if (Number.isNaN(deadline)) {
    throw new Error("Invalid body: 'until' must be an ISO 8601 timestamp");
  }
  if (deadline <= now) {
    throw new Error("Invalid body: 'until' must be in the future");
  }
  return new Date(deadline).toISOString();
}

/**
 * Resolve a local wall-clock `HH:MM` to the next future instant: today if it
 * is still ahead, otherwise tomorrow. Uses calendar-day arithmetic (not +24h)
 * so a DST change between now and the target lands on the right wall time.
 * Throws on a malformed clock or a wall time that does not exist (spring
 * forward gap).
 */
export function resolveClockUntil(clock: string, now: Date = new Date()): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(clock.trim());
  if (!m) throw new Error(`Invalid time '${clock}': use HH:MM (24-hour)`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  for (const dayOffset of [0, 1]) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hh, mm, 0, 0);
    if (t.getHours() !== hh || t.getMinutes() !== mm) {
      throw new Error(`Invalid time '${clock}': that local time does not exist (DST change)`);
    }
    if (t.getTime() > now.getTime()) return t.toISOString();
  }
  throw new Error(`Invalid time '${clock}'`);
}

/** Absolute mute: same stored shape as a duration mute. */
export function setMuteUntil(
  untilIso: string,
  path?: string,
  scope: MuteScope = "all",
): MuteState {
  const state = activeMute(parseMuteUntil(untilIso), scope);
  writeMuteState(state, path);
  return state;
}

/** "3:30 PM" (today) or "Sat 3:30 PM" in the daemon's local zone. */
export function formatMuteUntilLocal(untilIso: string | null, now: Date = new Date()): string | null {
  if (!untilIso) return null;
  const d = new Date(untilIso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === now.toDateString()
    ? time
    : `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}
