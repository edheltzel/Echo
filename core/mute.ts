// =============================================================================
// Runtime mute state — host-neutral (issue #83)
// =============================================================================
//
// One global mute switch, persisted as a tiny JSON file so a daemon restart
// cannot un-mute the user mid-meeting. Timed mutes store an ISO deadline and
// expire LAZILY at read time — no timers, no scheduler; a request arriving
// after the deadline behaves unmuted and the stale file is cleaned up
// opportunistically. Reads are tolerant: a missing, corrupt, or wrong-shaped
// file means unmuted, never a crash. Writes are atomic (temp + rename).
//
// The state shape is an object (not a bare boolean) so future role-scoped
// keys can extend it without migration.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveEchoEnv } from "./env";

export interface MuteState {
  muted: boolean;
  muted_until: string | null; // ISO timestamp; null = indefinite
}

const UNMUTED: MuteState = { muted: false, muted_until: null };

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
    console.warn(`🔇 Mute state file unreadable (${path}) — treating as unmuted`);
    return { ...UNMUTED };
  }

  if (typeof parsed?.muted !== 'boolean') {
    console.warn(`🔇 Mute state file malformed (${path}) — treating as unmuted`);
    return { ...UNMUTED };
  }
  if (!parsed.muted) return { ...UNMUTED };

  // A non-string, non-null deadline (e.g. a hand-edited numeric epoch) is a
  // malformed shape — falling back to "indefinite mute" would turn corruption
  // into the strongest possible mute, inverting the tolerant-read contract.
  if (parsed.muted_until != null && typeof parsed.muted_until !== 'string') {
    console.warn(`🔇 Mute state file malformed (${path}) — treating as unmuted`);
    return { ...UNMUTED };
  }

  const until = typeof parsed.muted_until === 'string' ? parsed.muted_until : null;
  if (until !== null) {
    const deadline = Date.parse(until);
    if (Number.isNaN(deadline)) {
      console.warn(`🔇 Mute deadline unparseable (${path}) — treating as unmuted`);
      return { ...UNMUTED };
    }
    if (deadline <= Date.now()) {
      // Lazy expiry: the timed mute has elapsed. Clean up opportunistically;
      // a failed cleanup is harmless (next read expires it again).
      try { writeMuteState({ ...UNMUTED }, path); } catch {}
      return { ...UNMUTED };
    }
  }

  return { muted: true, muted_until: until };
}

export function writeMuteState(state: MuteState, path: string = resolveMuteStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, path); // atomic on the same filesystem — no partial-file window
}

export function setMuteState(muted: boolean, durationMinutes?: number, path?: string): MuteState {
  const muted_until = muted && durationMinutes
    ? new Date(Date.now() + durationMinutes * 60_000).toISOString()
    : null;
  const state: MuteState = { muted, muted_until };
  writeMuteState(state, path);
  return state;
}

export function toggleMuteState(path?: string): MuteState {
  return setMuteState(!readMuteState(path).muted, undefined, path);
}
