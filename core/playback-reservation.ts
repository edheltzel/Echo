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
}

interface CaptureReservation {
  request_id: string;
  owner_pid: number;
  expires_at: number;
}

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
    activeReservation = null;
  }
}

export function trackPlayback(
  requestId: string,
  reservation?: { owner_pid: number; lease_ms: number },
): void {
  playback.set(requestId, {
    request_id: requestId,
    state: "queued",
    ...(reservation && {
      owner_pid: reservation.owner_pid,
      expires_at: Date.now() + reservation.lease_ms,
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
  reapExpiredReservation();
  const record = playback.get(requestId);
  if (!record) return null;
  const { owner_pid: _ownerPid, expires_at: _expiresAt, ...status } = record;
  return { ...status };
}

export function captureReservationHeld(): boolean {
  reapExpiredReservation();
  return activeReservation !== null;
}

export function captureReservationView(): { held: boolean; request_id?: string } {
  reapExpiredReservation();
  return activeReservation === null
    ? { held: false }
    : { held: true, request_id: activeReservation.request_id };
}

export function releaseCaptureReservation(requestId: string): boolean {
  reapExpiredReservation();
  if (activeReservation?.request_id !== requestId) return false;
  activeReservation = null;
  return true;
}
