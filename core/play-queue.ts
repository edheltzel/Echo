// =============================================================================
// Serial playback queue — host-neutral
// =============================================================================
// A single voice can't play two clips at once, so /notify work must run one at
// a time. Once the daemon returns `202` on receipt and does synth+play async
// (issue #202), bare fire-and-forget would let concurrent requests overlap
// their `afplay` processes — the leading "talking over each other" cause (plan
// R7). This queue serializes async tasks: `enqueue()` chains each task after the
// previous one SETTLES, so playback never overlaps. Errors are isolated — one
// task rejecting never breaks the chain for the next; the caller still gets the
// real result/rejection via the returned promise.

export interface SerialQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  readonly depth: number;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let depth = 0;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    depth++;
    // Chain after whatever is currently queued. `tail` is kept settled (never
    // rejected) so one task's failure can't poison the next.
    const run = tail.then(() => task());
    tail = run.then(
      () => { depth--; },
      () => { depth--; },
    );
    return run;
  }

  return {
    enqueue,
    get depth() { return depth; },
  };
}
