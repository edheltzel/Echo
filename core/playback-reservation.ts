// Per-notification completion and capture reservation state.
//
// The normal /notify contract remains receipt-based (202). Converse opts into
// this state so it can wait for its own request to finish and atomically hold
// the queue before the caller opens the microphone.

export type PlaybackState = "queued" | "playing" | "completed" | "failed";

export interface PlaybackStatus {
  request_id: string;
  state: PlaybackState;
  capture_reservation_id?: string;
  detail?: string;
}

interface PlaybackRecord extends PlaybackStatus {
  owner_pid?: number;
  expires_at?: number;
  created_at: number;
}

interface CaptureReservation {
  request_id: string;
  owner_pid: number;
  expires_at: number;
}

/**
 * Ceiling on a granted lease, whatever the caller asked for. A held reservation
 * makes the daemon skip every voice line, `/notify` is unauthenticated, and a
 * reservation owned by a pid that never dies (`owner_pid: 1`) would otherwise
 * never be reaped - so the lease, not the owner's liveness, is what bounds the
 * silence. The reservation only has to bridge playback completion to the moment
 * the caller publishes its capture state; the capture guard covers the rest of
 * the turn, so a caller with larger capture and transcription budgets loses
 * nothing by being clamped here.
 */
export const MAX_CAPTURE_LEASE_MS = 120_000;

/**
 * How long a record outlives its own lease. Records are opt-in, but a converse
 * turn whose playback ends in `failed` never activates a reservation and so is
 * never released by the caller: without a lifetime of its own it would sit in
 * the map for the daemon's whole run, once per failed turn.
 */
const RECORD_TTL_MS = MAX_CAPTURE_LEASE_MS + 60_000;

const playback = new Map<string, PlaybackRecord>();
let activeReservation: CaptureReservation | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reapExpiredReservation(): void {
  if (activeReservation === null) return;
  if (activeReservation.expires_at <= Date.now() || !pidAlive(activeReservation.owner_pid)) {
    playback.delete(activeReservation.request_id);
    activeReservation = null;
  }
}

/** The record backing the active reservation is reaped by its lease, never by age. */
function reapStaleRecords(): void {
  const cutoff = Date.now() - RECORD_TTL_MS;
  for (const [requestId, record] of playback) {
    if (activeReservation?.request_id === requestId) continue;
    if (record.created_at <= cutoff) playback.delete(requestId);
  }
}

function sweep(): void {
  reapExpiredReservation();
  reapStaleRecords();
}

export function trackPlayback(
  requestId: string,
  reservation?: { owner_pid: number; lease_ms: number },
): void {
  sweep();
  const now = Date.now();
  playback.set(requestId, {
    request_id: requestId,
    state: "queued",
    created_at: now,
    ...(reservation && {
      owner_pid: reservation.owner_pid,
      expires_at: now + Math.min(reservation.lease_ms, MAX_CAPTURE_LEASE_MS),
    }),
  });
}

export function markPlaybackPlaying(requestId: string): void {
  const record = playback.get(requestId);
  if (record) record.state = "playing";
}

export function markPlaybackFailed(requestId: string, detail: string): void {
  const record = playback.get(requestId);
  if (!record) return;
  record.state = "failed";
  record.detail = detail;
}

/** Mark a successfully played notification complete and activate its reservation in the same turn. */
export function markPlaybackCompleted(requestId: string, played: boolean, detail?: string): void {
  const record = playback.get(requestId);
  if (!record) return;
  if (!played) {
    markPlaybackFailed(requestId, detail ?? "notification did not play");
    return;
  }

  record.state = "completed";
  if (record.owner_pid !== undefined && record.expires_at !== undefined) {
    activeReservation = {
      request_id: requestId,
      owner_pid: record.owner_pid,
      expires_at: record.expires_at,
    };
    record.capture_reservation_id = requestId;
  }
}

export function readPlaybackStatus(requestId: string): PlaybackStatus | null {
  sweep();
  const record = playback.get(requestId);
  if (!record) return null;
  const { owner_pid: _ownerPid, expires_at: _expiresAt, created_at: _createdAt, ...status } = record;
  return { ...status };
}

export function captureReservationHeld(): boolean {
  sweep();
  return activeReservation !== null;
}

export function captureReservationView(): { held: boolean; request_id?: string } {
  sweep();
  return activeReservation === null
    ? { held: false }
    : { held: true, request_id: activeReservation.request_id };
}

export function releaseCaptureReservation(requestId: string): boolean {
  sweep();
  if (activeReservation?.request_id !== requestId) return false;
  activeReservation = null;
  playback.delete(requestId);
  return true;
}
