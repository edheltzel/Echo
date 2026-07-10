// Phase 2 / U1 — pure queue semantics against a fake player: global serial
// playback (R1), FIFO across sessions, newest-per-session coalescing (R4),
// age-cap drop at dequeue (R5), never interrupting the in-flight job (R3),
// and advancing past player errors (R6). No afplay, no server.

import { describe, expect, test } from "bun:test";
import { PlayQueue, type PlayJob } from "../../core/play-queue";

// Poll until `cond` holds (the consumer is async; there is no drain handle).
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

function job(id: string, sessionId: string | null, receivedAt = Date.now()): PlayJob<string> {
  return { id, sessionId, receivedAt, payload: id };
}

describe("PlayQueue — serial playback (R1)", () => {
  test("jobs play one at a time; max observed concurrency is 1", async () => {
    const played: string[] = [];
    let active = 0;
    let maxActive = 0;
    const q = new PlayQueue<string>({
      player: async (j) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(20);
        played.push(j.id);
        active--;
      },
    });

    q.enqueue(job("a", "s1"));
    q.enqueue(job("b", "s2"));
    q.enqueue(job("c", "s3"));

    await waitFor(() => played.length === 3);
    expect(maxActive).toBe(1);
    expect(played).toEqual(["a", "b", "c"]); // FIFO across distinct sessions
  });

  test("consumer idles when empty and wakes on a later enqueue", async () => {
    const played: string[] = [];
    const q = new PlayQueue<string>({
      player: async (j) => { played.push(j.id); },
    });

    q.enqueue(job("first", "s1"));
    await waitFor(() => played.length === 1);

    // Queue fully drained; a later enqueue must still be consumed.
    await Bun.sleep(20);
    q.enqueue(job("second", "s2"));
    await waitFor(() => played.length === 2);
    expect(played).toEqual(["first", "second"]);
  });
});

describe("PlayQueue — newest-per-session coalescing (R4)", () => {
  test("a newer same-session line replaces the queued one; the old emits superseded", async () => {
    const played: string[] = [];
    const dispositions: Array<{ id: string; disposition: string }> = [];
    let releaseBlocker!: () => void;
    const blocked = new Promise<void>((r) => { releaseBlocker = r; });

    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "blocker") await blocked;
        played.push(j.id);
      },
      onDisposition: (j, disposition) => dispositions.push({ id: j.id, disposition }),
    });

    q.enqueue(job("blocker", "s-block"));
    await waitFor(() => q.depth === 0); // blocker dequeued, now in-flight
    q.enqueue(job("old", "s1"));
    q.enqueue(job("new", "s1")); // supersedes "old" while it is still queued
    releaseBlocker();

    await waitFor(() => played.length === 2);
    expect(played).toEqual(["blocker", "new"]);
    expect(dispositions).toEqual([{ id: "old", disposition: "superseded" }]);
  });

  test("a same-session line never interrupts the in-flight job (R3)", async () => {
    const played: string[] = [];
    const dispositions: string[] = [];
    let releaseBlocker!: () => void;
    const blocked = new Promise<void>((r) => { releaseBlocker = r; });

    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "playing") await blocked;
        played.push(j.id);
      },
      onDisposition: (j) => dispositions.push(j.id),
    });

    q.enqueue(job("playing", "s1"));
    await waitFor(() => q.depth === 0); // "playing" is in-flight
    q.enqueue(job("later", "s1"));      // same session as the IN-FLIGHT job
    releaseBlocker();

    await waitFor(() => played.length === 2);
    // The in-flight job finished normally and was NOT superseded.
    expect(played).toEqual(["playing", "later"]);
    expect(dispositions).toEqual([]);
  });

  test("lines with no session_id never coalesce with each other", async () => {
    const played: string[] = [];
    let releaseBlocker!: () => void;
    const blocked = new Promise<void>((r) => { releaseBlocker = r; });

    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "blocker") await blocked;
        played.push(j.id);
      },
    });

    q.enqueue(job("blocker", "s-block"));
    await waitFor(() => q.depth === 0);
    q.enqueue(job("anon1", null));
    q.enqueue(job("anon2", null));
    releaseBlocker();

    await waitFor(() => played.length === 3);
    expect(played).toEqual(["blocker", "anon1", "anon2"]);
  });
});

describe("PlayQueue — age cap at dequeue (R5)", () => {
  test("a job older than ageCapMs is dropped stale and never played", async () => {
    let clock = 1_000_000;
    const played: string[] = [];
    const dispositions: Array<{ id: string; disposition: string }> = [];

    const q = new PlayQueue<string>({
      player: async (j) => { played.push(j.id); },
      onDisposition: (j, disposition) => dispositions.push({ id: j.id, disposition }),
      ageCapMs: 500,
      now: () => clock,
    });

    q.enqueue({ id: "stale", sessionId: "s1", receivedAt: clock - 501, payload: "stale" });
    q.enqueue({ id: "fresh", sessionId: "s2", receivedAt: clock, payload: "fresh" });

    await waitFor(() => played.length === 1);
    expect(played).toEqual(["fresh"]);
    expect(dispositions).toEqual([{ id: "stale", disposition: "dropped-stale" }]);
  });

  test("a job exactly at the cap still plays (drop is strictly older)", async () => {
    let clock = 1_000_000;
    const played: string[] = [];
    const q = new PlayQueue<string>({
      player: async (j) => { played.push(j.id); },
      ageCapMs: 500,
      now: () => clock,
    });

    q.enqueue({ id: "edge", sessionId: "s1", receivedAt: clock - 500, payload: "edge" });
    await waitFor(() => played.length === 1);
    expect(played).toEqual(["edge"]);
  });
});

describe("PlayQueue — depth cap (belt-and-suspenders)", () => {
  test("enqueue beyond maxDepth drops the oldest queued job", async () => {
    const played: string[] = [];
    const dispositions: Array<{ id: string; disposition: string }> = [];
    let releaseBlocker!: () => void;
    const blocked = new Promise<void>((r) => { releaseBlocker = r; });

    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "blocker") await blocked;
        played.push(j.id);
      },
      onDisposition: (j, disposition) => dispositions.push({ id: j.id, disposition }),
      maxDepth: 2,
    });

    q.enqueue(job("blocker", "s-block"));
    await waitFor(() => q.depth === 0);
    q.enqueue(job("q1", "s1"));
    q.enqueue(job("q2", "s2"));
    q.enqueue(job("q3", "s3")); // exceeds depth 2 → q1 (oldest queued) dropped
    expect(q.depth).toBe(2);
    releaseBlocker();

    await waitFor(() => played.length === 3);
    expect(played).toEqual(["blocker", "q2", "q3"]);
    expect(dispositions).toEqual([{ id: "q1", disposition: "dropped-stale" }]);
  });
});

describe("PlayQueue — resilience (R6)", () => {
  test("a rejecting player does not stall the queue; the next job still plays", async () => {
    const played: string[] = [];
    const errors: string[] = [];
    const q = new PlayQueue<string>({
      player: async (j) => {
        if (j.id === "boom") throw new Error("player exploded");
        played.push(j.id);
      },
      onPlayerError: (j) => errors.push(j.id),
    });

    q.enqueue(job("boom", "s1"));
    q.enqueue(job("after", "s2"));

    await waitFor(() => played.length === 1);
    expect(played).toEqual(["after"]);
    expect(errors).toEqual(["boom"]);
  });

  test("a throwing disposition callback does not stall the queue", async () => {
    let clock = 1_000_000;
    const played: string[] = [];
    const q = new PlayQueue<string>({
      player: async (j) => { played.push(j.id); },
      onDisposition: () => { throw new Error("callback exploded"); },
      ageCapMs: 500,
      now: () => clock,
    });

    q.enqueue({ id: "stale", sessionId: "s1", receivedAt: clock - 10_000, payload: "stale" });
    q.enqueue({ id: "fresh", sessionId: "s2", receivedAt: clock, payload: "fresh" });

    await waitFor(() => played.length === 1);
    expect(played).toEqual(["fresh"]);
  });
});
