import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  captureReservationHeld,
  markPlaybackCompleted,
  markPlaybackFailed,
  markPlaybackPlaying,
  MAX_CAPTURE_LEASE_MS,
  readPlaybackStatus,
  releaseCaptureReservation,
  trackPlayback,
} from "../../core/playback-reservation";

afterEach(() => {
  setSystemTime();
});

describe("core playback completion reservation", () => {
  test("publishes the exact request completion and holds new playback until release", () => {
    const requestId = `reservation-${Date.now()}`;
    trackPlayback(requestId, { owner_pid: process.pid, lease_ms: 60_000 });
    expect(readPlaybackStatus(requestId)).toEqual({ request_id: requestId, state: "queued" });

    markPlaybackPlaying(requestId);
    expect(readPlaybackStatus(requestId)?.state).toBe("playing");

    markPlaybackCompleted(requestId, true);
    expect(readPlaybackStatus(requestId)).toEqual({
      request_id: requestId,
      state: "completed",
      capture_reservation_id: requestId,
    });
    expect(captureReservationHeld()).toBe(true);

    expect(releaseCaptureReservation(requestId)).toBe(true);
    expect(captureReservationHeld()).toBe(false);
  });

  // /notify is unauthenticated, so the lease a caller asks for is not something
  // to be trusted: an owner pid that never exits (pid 1) plus a day-long lease
  // would hold back every voice line with no recovery short of a restart.
  test("clamps an oversized lease so a held reservation always expires", () => {
    const requestId = `oversized-${Date.now()}`;
    trackPlayback(requestId, { owner_pid: process.pid, lease_ms: 86_400_000 });
    markPlaybackCompleted(requestId, true);
    expect(captureReservationHeld()).toBe(true);

    setSystemTime(new Date(Date.now() + MAX_CAPTURE_LEASE_MS + 1_000));

    expect(captureReservationHeld()).toBe(false);
    expect(readPlaybackStatus(requestId)).toBeNull();
  });

  // A turn whose playback failed never activates a reservation, so its caller
  // never releases it. Without a lifetime of its own the record would sit in the
  // map for the daemon's whole run, once per failed turn.
  test("reaps a failed record instead of keeping it for the daemon's lifetime", () => {
    const requestId = `failed-${Date.now()}`;
    trackPlayback(requestId, { owner_pid: process.pid, lease_ms: 60_000 });
    markPlaybackFailed(requestId, "queue dropped it");
    expect(readPlaybackStatus(requestId)?.state).toBe("failed");

    // Still readable while the caller could plausibly still be polling.
    setSystemTime(new Date(Date.now() + 30_000));
    expect(readPlaybackStatus(requestId)?.state).toBe("failed");

    setSystemTime(new Date(Date.now() + 60 * 60_000));
    expect(readPlaybackStatus(requestId)).toBeNull();
  });
});
