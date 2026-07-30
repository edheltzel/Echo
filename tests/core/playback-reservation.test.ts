import { describe, expect, test } from "bun:test";
import {
  captureReservationHeld,
  captureReservationView,
  grantCaptureReservation,
  markPlaybackCompleted,
  markPlaybackPlaying,
  readPlaybackStatus,
  releaseCaptureReservationById,
  trackPlayback,
} from "../../core/playback-reservation";

describe("core playback completion reservation", () => {
  test("publishes exact completion and holds new playback until release", () => {
    const requestId = `request-${crypto.randomUUID()}`;
    const reservationId = `reservation-${crypto.randomUUID()}`;
    trackPlayback(requestId, { reservation_id: reservationId, owner_pid: process.pid, lease_ms: 60_000 });
    expect(readPlaybackStatus(requestId)).toEqual({ request_id: requestId, state: "queued" });

    markPlaybackPlaying(requestId);
    expect(readPlaybackStatus(requestId)?.state).toBe("playing");

    markPlaybackCompleted(requestId, true);
    expect(readPlaybackStatus(requestId)).toEqual({
      request_id: requestId,
      state: "completed",
      capture_reservation_id: reservationId,
    });
    expect(captureReservationHeld()).toBe(true);

    expect(releaseCaptureReservationById(reservationId)).toEqual({ acknowledged: true, matched: true });
    expect(captureReservationHeld()).toBe(false);
  });

  test("starts the protected lease at the explicit capture grant", () => {
    const originalNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const requestId = `request-${crypto.randomUUID()}`;
    const reservationId = `reservation-${crypto.randomUUID()}`;

    try {
      trackPlayback(requestId, { reservation_id: reservationId, owner_pid: process.pid, lease_ms: 10_000 });
      now += 11_000;
      markPlaybackCompleted(requestId, true);
      now += 4_000;

      const granted = grantCaptureReservation(reservationId);

      expect(granted.granted).toBe(true);
      expect(granted.granted && Date.parse(granted.expires_at) - now).toBe(10_000);
      expect(Date.parse(captureReservationView().expires_at!)).toBe(now + 10_000);
    } finally {
      releaseCaptureReservationById(reservationId);
      Date.now = originalNow;
    }
  });

  test("releases an accepted reservation by coordinator token when the notify response is lost", () => {
    const requestId = `request-${crypto.randomUUID()}`;
    const reservationId = `reservation-${crypto.randomUUID()}`;
    trackPlayback(requestId, { reservation_id: reservationId, owner_pid: process.pid, lease_ms: 60_000 });
    markPlaybackCompleted(requestId, true);
    expect(captureReservationHeld()).toBe(true);

    expect(releaseCaptureReservationById(reservationId)).toEqual({ acknowledged: true, matched: true });
    expect(captureReservationHeld()).toBe(false);
  });

  test("a release that races ahead of notify acceptance prevents later activation", () => {
    const requestId = `request-${crypto.randomUUID()}`;
    const reservationId = `reservation-${crypto.randomUUID()}`;

    expect(releaseCaptureReservationById(reservationId)).toEqual({ acknowledged: true, matched: false });
    trackPlayback(requestId, { reservation_id: reservationId, owner_pid: process.pid, lease_ms: 60_000 });
    markPlaybackCompleted(requestId, true);

    expect(captureReservationHeld()).toBe(false);
    expect(readPlaybackStatus(requestId)).toBeNull();
  });
});
