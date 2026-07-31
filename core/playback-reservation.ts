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

export interface CaptureReservationRequest {
  reservation_id: string;
  owner_pid: number;
  lease_ms: number;
}

interface PlaybackRecord extends PlaybackStatus {
  reservation_id?: string;
  owner_pid?: number;
  lease_ms?: number;
  released?: boolean;
  stale_at: number;
}

interface CaptureReservation {
  reservation_id: string;
  request_id: string;
  owner_pid: number;
  lease_ms: number;
  expires_at: number;
}

export type CaptureGrantResult =
  | { granted: true; reservation_id: string; request_id: string; expires_at: string }
  | { granted: false; reason: "not_ready" };

export interface CaptureReleaseResult {
  acknowledged: true;
  matched: boolean;
}

const PREACCEPT_RELEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const STALE_PLAYBACK_TTL_MS = 15 * 60 * 1_000;
const playback = new Map<string, PlaybackRecord>();
const releasedBeforeAcceptance = new Map<string, number>();
let activeReservation: CaptureReservation | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pruneReleaseTombstones(now: number = Date.now()): void {
  for (const [reservationId, expiresAt] of releasedBeforeAcceptance) {
    if (expiresAt <= now) releasedBeforeAcceptance.delete(reservationId);
  }
}

function reapExpiredReservation(): void {
  if (activeReservation === null) return;
  if (activeReservation.expires_at <= Date.now() || !pidAlive(activeReservation.owner_pid)) {
    playback.delete(activeReservation.request_id);
    activeReservation = null;
  }
}

/**
 * Drop records a crashed coordinator never released. A record parked in any
 * state without a release call would otherwise live for the daemon's lifetime;
 * the active reservation is exempt because its own lease already reaps it.
 */
function pruneStalePlayback(now: number = Date.now()): void {
  for (const [requestId, record] of playback) {
    if (record.stale_at > now) continue;
    if (activeReservation?.request_id === requestId) continue;
    playback.delete(requestId);
  }
}

export function trackPlayback(requestId: string, reservation?: CaptureReservationRequest): void {
  pruneReleaseTombstones();
  pruneStalePlayback();
  const released = reservation !== undefined && releasedBeforeAcceptance.delete(reservation.reservation_id);
  playback.set(requestId, {
    request_id: requestId,
    state: "queued",
    stale_at: Date.now() + STALE_PLAYBACK_TTL_MS,
    ...(reservation && !released && {
      reservation_id: reservation.reservation_id,
      owner_pid: reservation.owner_pid,
      lease_ms: reservation.lease_ms,
    }),
    ...(released && { released: true }),
  });
}

export function markPlaybackPlaying(requestId: string): void {
  const record = playback.get(requestId);
  if (!record) return;
  record.state = "playing";
  record.stale_at = Date.now() + STALE_PLAYBACK_TTL_MS;
}

export function markPlaybackFailed(requestId: string, detail: string): void {
  const record = playback.get(requestId);
  if (!record) return;
  if (record.released) {
    playback.delete(requestId);
    return;
  }
  record.state = "failed";
  record.detail = detail;
  record.stale_at = Date.now() + STALE_PLAYBACK_TTL_MS;
}

/** Mark successful playback complete and block later speech before capture can start. */
export function markPlaybackCompleted(requestId: string, played: boolean, detail?: string): void {
  const record = playback.get(requestId);
  if (!record) return;
  if (record.released) {
    playback.delete(requestId);
    return;
  }
  if (!played) {
    markPlaybackFailed(requestId, detail ?? "notification did not play");
    return;
  }

  record.state = "completed";
  record.stale_at = Date.now() + STALE_PLAYBACK_TTL_MS;
  if (
    record.reservation_id !== undefined &&
    record.owner_pid !== undefined &&
    record.lease_ms !== undefined
  ) {
    activeReservation = {
      reservation_id: record.reservation_id,
      request_id: requestId,
      owner_pid: record.owner_pid,
      lease_ms: record.lease_ms,
      // This first expiry protects the completion-to-grant handshake. The
      // coordinator explicitly rebases it at the capture grant below.
      expires_at: Date.now() + record.lease_ms,
    };
    record.capture_reservation_id = record.reservation_id;
  }
}

export function readPlaybackStatus(requestId: string): PlaybackStatus | null {
  reapExpiredReservation();
  pruneStalePlayback();
  const record = playback.get(requestId);
  if (!record) return null;
  const {
    reservation_id: _reservationId,
    owner_pid: _ownerPid,
    lease_ms: _leaseMs,
    released: _released,
    stale_at: _staleAt,
    ...status
  } = record;
  return { ...status };
}

export function captureReservationHeld(): boolean {
  reapExpiredReservation();
  return activeReservation !== null;
}

export function captureReservationView(): { held: boolean; request_id?: string; reservation_id?: string; expires_at?: string } {
  reapExpiredReservation();
  return activeReservation === null
    ? { held: false }
    : {
        held: true,
        request_id: activeReservation.request_id,
        reservation_id: activeReservation.reservation_id,
        expires_at: new Date(activeReservation.expires_at).toISOString(),
      };
}

/** Start the capture lease at the actual grant, not at notify acceptance or playback completion. */
export function grantCaptureReservation(reservationId: string): CaptureGrantResult {
  reapExpiredReservation();
  if (activeReservation?.reservation_id !== reservationId) return { granted: false, reason: "not_ready" };

  activeReservation.expires_at = Date.now() + activeReservation.lease_ms;
  return {
    granted: true,
    reservation_id: reservationId,
    request_id: activeReservation.request_id,
    expires_at: new Date(activeReservation.expires_at).toISOString(),
  };
}

function releaseRecord(record: PlaybackRecord): void {
  record.released = true;
  if (activeReservation?.request_id === record.request_id) activeReservation = null;
  if (record.state === "completed" || record.state === "failed") playback.delete(record.request_id);
}

/**
 * Idempotent release by the coordinator-generated reservation id, the ONLY key
 * a release accepts. Core request ids come off a predictable counter, so a
 * release keyed on one would let any local process drop a live microphone
 * interlock by guessing an id.
 *
 * An unmatched release leaves a bounded tombstone so a /notify request whose
 * response was lost cannot arrive a moment later and create an unreleasable
 * reservation. This is the recovery path that does not require a core request id.
 */
export function releaseCaptureReservationById(reservationId: string): CaptureReleaseResult {
  reapExpiredReservation();
  pruneReleaseTombstones();
  const record = [...playback.values()].find((candidate) => candidate.reservation_id === reservationId);
  if (record) {
    releaseRecord(record);
    return { acknowledged: true, matched: true };
  }

  releasedBeforeAcceptance.set(reservationId, Date.now() + PREACCEPT_RELEASE_TTL_MS);
  return { acknowledged: true, matched: false };
}
