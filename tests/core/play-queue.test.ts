// Serial playback queue (#202 / plan R7): tasks run one-at-a-time, in FIFO
// order, and a rejecting task never blocks the ones behind it.

import { describe, expect, test } from "bun:test";
import { createSerialQueue } from "../../core/play-queue";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("createSerialQueue", () => {
  test("runs tasks one at a time (no overlap)", async () => {
    const q = createSerialQueue();
    let active = 0;
    let maxActive = 0;

    const task = () => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(10);
      active--;
    };

    await Promise.all([q.enqueue(task()), q.enqueue(task()), q.enqueue(task())]);
    expect(maxActive).toBe(1);
  });

  test("preserves FIFO order", async () => {
    const q = createSerialQueue();
    const order: number[] = [];
    const jobs = [0, 1, 2, 3].map((i) =>
      q.enqueue(async () => {
        await tick(2);
        order.push(i);
      }),
    );
    await Promise.all(jobs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("a rejecting task does not block subsequent tasks", async () => {
    const q = createSerialQueue();
    const rejected = q.enqueue(async () => {
      throw new Error("boom");
    });
    const after = q.enqueue(async () => "ok");

    await expect(rejected).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });

  test("returns the task's resolved value", async () => {
    const q = createSerialQueue();
    await expect(q.enqueue(async () => 42)).resolves.toBe(42);
  });

  test("depth reflects outstanding tasks and drains to zero", async () => {
    const q = createSerialQueue();
    const a = q.enqueue(() => tick(10));
    const b = q.enqueue(() => tick(10));
    expect(q.depth).toBe(2);
    await Promise.all([a, b]);
    expect(q.depth).toBe(0);
  });
});
