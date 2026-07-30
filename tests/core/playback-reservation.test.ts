import { describe, expect, test } from "bun:test";
import {
  captureReservationHeld,
  markPlaybackCompleted,
  markPlaybackPlaying,
  readPlaybackStatus,
  releaseCaptureReservation,
  trackPlayback,
} from "../../core/playback-reservation";

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
});
