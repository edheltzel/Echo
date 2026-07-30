import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireBooking,
  isBookingStale,
  readBooking,
  releaseBooking,
  renewBooking,
  type BookingRecord,
} from "../../converse/booking.ts";

// One microphone, one human, N agents: the lock is what makes concurrent asks
// serialize instead of talking over each other, and reaping is what keeps a
// crashed ask from wedging every later one.

let scratch: string;
let lockPath: string;

const ALIVE = () => true;
const DEAD = () => false;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-booking-"));
  lockPath = join(scratch, "state", "booking.lock");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function acquire(turnId: string, ownerPid = 4242, overrides: Partial<{ leaseMs: number; now: () => number; isPidAlive: (pid: number) => boolean }> = {}) {
  return acquireBooking({
    path: lockPath,
    turnId,
    ownerPid,
    source: "test",
    leaseMs: overrides.leaseMs ?? 60_000,
    now: overrides.now,
    isPidAlive: overrides.isPidAlive ?? ALIVE,
  });
}

describe("microphone booking lock", () => {
  test("acquiring on a clean path creates an owner-only lock", () => {
    const outcome = acquire("turn-1", 111);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reaped).toBeNull();
    expect(outcome.record.turn_id).toBe("turn-1");
    expect(outcome.record.owner_pid).toBe(111);
    expect(readBooking(lockPath)?.turn_id).toBe("turn-1");
    // 0600: the lock names a live pid, which is nobody else's business.
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
  });

  test("a second ask against a live holder is refused, not queued", () => {
    acquire("turn-1", 111);
    const second = acquire("turn-2", 222);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.held_by?.turn_id).toBe("turn-1");
    // The refusal must not disturb the winner's lock.
    expect(readBooking(lockPath)?.turn_id).toBe("turn-1");
  });

  test("concurrent acquires produce exactly one winner", () => {
    const outcomes = ["a", "b", "c", "d"].map((id) => acquire(`turn-${id}`, 111));
    const winners = outcomes.filter((outcome) => outcome.ok);

    expect(winners.length).toBe(1);
    expect(readBooking(lockPath)?.turn_id).toBe("turn-a");
  });

  test("a dead owner is reaped rather than deadlocking every later ask", () => {
    acquire("crashed-turn", 999, { isPidAlive: ALIVE });

    const next = acquire("turn-2", 222, { isPidAlive: DEAD });

    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.reaped?.turn_id).toBe("crashed-turn");
    expect(readBooking(lockPath)?.turn_id).toBe("turn-2");
  });

  test("an expired lease is reaped even while its owner is still alive", () => {
    let clock = 1_000_000;
    acquire("abandoned-turn", 111, { leaseMs: 5_000, now: () => clock });

    clock += 5_001;
    const next = acquire("turn-2", 222, { now: () => clock, isPidAlive: ALIVE });

    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.reaped?.turn_id).toBe("abandoned-turn");
  });

  test("a lease that has not expired still holds", () => {
    let clock = 1_000_000;
    acquire("turn-1", 111, { leaseMs: 5_000, now: () => clock });

    clock += 4_999;
    const next = acquire("turn-2", 222, { now: () => clock, isPidAlive: ALIVE });

    expect(next.ok).toBe(false);
  });

  test("an unreadable lock file is reaped, never treated as a permanent holder", () => {
    acquire("turn-1", 111);
    writeFileSync(lockPath, "{ this is not json");

    const next = acquire("turn-2", 222, { isPidAlive: ALIVE });

    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.reaped).toBeNull(); // nothing legible to report as reaped
    expect(readBooking(lockPath)?.turn_id).toBe("turn-2");
  });

  test("releasing returns the microphone", () => {
    acquire("turn-1", 111);

    const released = releaseBooking(lockPath, "turn-1");

    expect(released.released).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(acquire("turn-2", 222).ok).toBe(true);
  });

  test("a late completion cannot release the booking a different turn now holds", () => {
    acquire("turn-1", 111, { isPidAlive: DEAD });
    const second = acquire("turn-2", 222, { isPidAlive: DEAD });
    expect(second.ok).toBe(true);

    const stale = releaseBooking(lockPath, "turn-1");

    expect(stale).toEqual({ released: false, reason: "owned_by_another_turn" });
    expect(readBooking(lockPath)?.turn_id).toBe("turn-2");
  });

  test("releasing an unheld lock reports it instead of throwing", () => {
    expect(releaseBooking(lockPath, "turn-1")).toEqual({ released: false, reason: "not_held" });
  });

  test("the lock records the lease window it was granted for", () => {
    const outcome = acquire("turn-1", 111, { leaseMs: 90_000, now: () => 1_700_000_000_000 });

    expect(outcome.ok).toBe(true);
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as BookingRecord;
    expect(Date.parse(record.expires_at) - Date.parse(record.acquired_at)).toBe(90_000);
  });
});

describe("staleness rule", () => {
  const record: BookingRecord = {
    turn_id: "t",
    owner_pid: 5,
    source: "test",
    acquired_at: new Date(1_000).toISOString(),
    expires_at: new Date(61_000).toISOString(),
  };

  test("a live owner inside its lease is not stale", () => {
    expect(isBookingStale(record, 60_000, ALIVE)).toBe(false);
  });

  test("a dead owner is stale", () => {
    expect(isBookingStale(record, 60_000, DEAD)).toBe(true);
  });

  test("an unparseable expiry is stale, not immortal", () => {
    expect(isBookingStale({ ...record, expires_at: "whenever" }, 60_000, ALIVE)).toBe(true);
  });

  test("a missing record is stale", () => {
    expect(isBookingStale(null, 60_000, ALIVE)).toBe(true);
  });
});

// The booking must be taken before the question is spoken, or two asks would
// both get as far as speaking. But the lease is meant to bound the phase where
// the microphone is open, which only starts once the question has played. Left
// on the original clock, a question queued behind other lines leaves the booking
// reapable the moment the recorder starts.
describe("re-basing a lease at the grant", () => {
  test("extends the holder's own booking to the new expiry", () => {
    const outcome = acquire("turn-1", 111, { leaseMs: 5_000, now: () => 1_700_000_000_000 });
    expect(outcome.ok).toBe(true);

    expect(renewBooking(lockPath, "turn-1", 1_700_000_600_000)).toBe(true);

    const held = readBooking(lockPath);
    expect(Date.parse(held!.expires_at)).toBe(1_700_000_600_000);
    // Identity is untouched: only the clock moved.
    expect(held!.turn_id).toBe("turn-1");
    expect(held!.owner_pid).toBe(111);
  });

  test("refuses to extend a booking a different turn now holds", () => {
    acquire("turn-1", 111, { leaseMs: 5_000, now: () => 1_700_000_000_000 });

    expect(renewBooking(lockPath, "some-other-turn", 1_700_000_600_000)).toBe(false);
    expect(Date.parse(readBooking(lockPath)!.expires_at)).toBe(1_700_000_005_000);
  });

  test("a missing lock is reported rather than recreated", () => {
    expect(renewBooking(lockPath, "turn-1", 1_700_000_600_000)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });
});
