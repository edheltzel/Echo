// Single-microphone booking lock.
//
// There is one microphone and one human, and N agents may ask at the same
// instant. The lock is a file created with `wx` (open-exclusive), so the winner
// is decided by the filesystem rather than by a check-then-act race: two
// coordinators racing cannot both believe they hold the microphone.
//
// A held lock must never outlive its holder. VoiceLayer called orphan reaping
// its "#1 reliability fix", and the failure it prevents is the worst one here:
// a crashed ask leaves a lock file behind and every later ask fails forever. So
// a lock counts as held only while its owner process is alive AND its lease has
// not expired; anything else is reaped and the caller proceeds.
//
// Lease semantics mirror core/capture-guard.ts's stale-crash guard on purpose:
// same liveness probe, same "a dead writer means nothing is happening" rule.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface BookingRecord {
  turn_id: string;
  owner_pid: number;
  source: string;
  acquired_at: string;
  expires_at: string;
}

export type BookingOutcome =
  | { ok: true; record: BookingRecord; reaped: BookingRecord | null }
  /** `held_by: null` means the lock file is unreadable, not that nobody holds it. */
  | { ok: false; held_by: BookingRecord | null };

/** Signal 0 probes the pid; EPERM reads as dead, exactly as core's guard does. */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isBookingRecord(value: unknown): value is BookingRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.turn_id === "string" &&
    typeof record.owner_pid === "number" &&
    typeof record.source === "string" &&
    typeof record.acquired_at === "string" &&
    typeof record.expires_at === "string"
  );
}

/** Tolerant read: missing, corrupt, or wrong-shaped all read as "no usable holder". */
export function readBooking(path: string): BookingRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isBookingRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isBookingStale(
  record: BookingRecord | null,
  now: number = Date.now(),
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): boolean {
  if (record === null) return true; // unreadable lock is not worth deadlocking on
  if (!isPidAlive(record.owner_pid)) return true;
  const expires = Date.parse(record.expires_at);
  return Number.isNaN(expires) || expires <= now;
}

function writeExclusive(path: string, record: BookingRecord): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
  return true;
}

export interface AcquireBookingOptions {
  path: string;
  turnId: string;
  ownerPid: number;
  source: string;
  leaseMs: number;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
}

/**
 * Take the microphone booking, reaping a dead or expired owner first. Never
 * blocks: a live holder yields `ok: false` so the caller can answer 409 rather
 * than leave an interactive prompt queued behind an invisible wait.
 */
export function acquireBooking(options: AcquireBookingOptions): BookingOutcome {
  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const startedAt = now();
  const record: BookingRecord = {
    turn_id: options.turnId,
    owner_pid: options.ownerPid,
    source: options.source,
    acquired_at: new Date(startedAt).toISOString(),
    expires_at: new Date(startedAt + options.leaseMs).toISOString(),
  };

  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });

  if (writeExclusive(options.path, record)) return { ok: true, record, reaped: null };

  const holder = readBooking(options.path);
  if (!isBookingStale(holder, startedAt, isPidAlive)) return { ok: false, held_by: holder };

  // Reap the orphan. `unlink` racing another reaper is fine: whoever loses the
  // following `wx` create simply reports the new holder.
  try {
    unlinkSync(options.path);
  } catch {
    // Already gone (another reaper won). The create below decides the outcome.
  }

  if (writeExclusive(options.path, record)) return { ok: true, record, reaped: holder };
  return { ok: false, held_by: readBooking(options.path) };
}

/** Rebase this turn's booking at the actual capture grant. */
export function renewBooking(path: string, turnId: string, expiresAtMs: number): boolean {
  const holder = readBooking(path);
  if (holder === null || holder.turn_id !== turnId) return false;

  const staging = join(dirname(path), `.${process.pid}.booking.tmp`);
  try {
    writeFileSync(staging, JSON.stringify({ ...holder, expires_at: new Date(expiresAtMs).toISOString() }), { mode: 0o600 });
    renameSync(staging, path);
    return true;
  } catch {
    try {
      unlinkSync(staging);
    } catch {
      // The staging file was never created or was already removed.
    }
    return false;
  }
}

export type ReleaseOutcome =
  | { released: true; record: BookingRecord }
  | { released: false; reason: "not_held" | "owned_by_another_turn" };

/**
 * Release only the caller's own booking. A turn that timed out and was reaped
 * must not, on late completion, delete the lock a different turn now holds.
 */
export function releaseBooking(path: string, turnId: string): ReleaseOutcome {
  if (!existsSync(path)) return { released: false, reason: "not_held" };
  const holder = readBooking(path);
  if (holder !== null && holder.turn_id !== turnId) {
    return { released: false, reason: "owned_by_another_turn" };
  }
  try {
    unlinkSync(path);
  } catch {
    return { released: false, reason: "not_held" };
  }
  return holder === null
    ? { released: false, reason: "not_held" }
    : { released: true, record: holder };
}
