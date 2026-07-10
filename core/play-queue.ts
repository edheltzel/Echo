// =============================================================================
// Play Queue — host-neutral global playback serialization (Phase 2)
// =============================================================================
//
// One voice at a time, globally (R1): an in-process FIFO drained by a single
// async consumer that awaits an injected `player` for one job at a time. The
// queue holds opaque payloads and knows nothing about TTS or hosts (KTD2) —
// the daemon hands it the ALS speak path; tests hand it a fake player.
//
// Semantics:
// - Newest-per-session coalescing (R4/KTD3): enqueueing a job whose sessionId
//   matches a QUEUED job replaces that job in place (keeping its queue slot)
//   and reports it `superseded`. The in-flight job was already dequeued, so it
//   is never touched (R3 — no barge-in).
// - Age cap at dequeue (R5/KTD7): a job that waited longer than `ageCapMs`
//   since receipt is reported `dropped-stale` instead of played — better
//   silent than stale.
// - Depth cap (belt-and-suspenders): enqueueing beyond `maxDepth` drops the
//   oldest queued job as `dropped-stale`.
// - Resilience (R6): player rejections are caught and reported; the consumer
//   always advances. Callback failures are swallowed — reporting must never
//   stall playback. When idle the consumer awaits a wake signal (no polling).

import { parseBoundedInt } from "./env";

// Queue-side outcomes. `played` rows are written by the player itself.
export type QueueDropDisposition = "dropped-stale" | "superseded";

export interface PlayJob<T> {
  id: string;
  sessionId: string | null;
  receivedAt: number; // epoch ms at receipt; age-cap ages from here
  payload: T;
}

export interface PlayQueueOptions<T> {
  player: (job: PlayJob<T>) => Promise<void>;
  onDisposition?: (job: PlayJob<T>, disposition: QueueDropDisposition, reason: string) => void;
  onPlayerError?: (job: PlayJob<T>, error: unknown) => void;
  ageCapMs?: number;
  maxDepth?: number;
  now?: () => number; // injectable clock for deterministic age-cap tests
}

export class PlayQueue<T> {
  readonly ageCapMs: number;
  readonly maxDepth: number;

  private readonly opts: PlayQueueOptions<T>;
  private readonly queue: PlayJob<T>[] = [];
  private wake: (() => void) | null = null;

  constructor(opts: PlayQueueOptions<T>) {
    this.opts = opts;
    // Bounded env reads (ECHO_* convention): a NaN/negative/zero override
    // falls back to the default rather than a degenerate cap that would drop
    // everything (age cap floor 1s) or serialize nothing (depth floor 1).
    this.ageCapMs = opts.ageCapMs
      ?? parseBoundedInt(process.env.ECHO_PLAY_QUEUE_AGE_CAP_MS, 30_000, 1_000);
    this.maxDepth = opts.maxDepth
      ?? parseBoundedInt(process.env.ECHO_PLAY_QUEUE_MAX_DEPTH, 20, 1);
    void this.consume();
  }

  /** Queued (not in-flight) job count. */
  get depth(): number {
    return this.queue.length;
  }

  enqueue(job: PlayJob<T>): void {
    if (job.sessionId !== null) {
      const i = this.queue.findIndex((q) => q.sessionId === job.sessionId);
      if (i !== -1) {
        // Newer line from the same session: replace in place so the session
        // keeps its queue slot (fair ordering), report the old line.
        const old = this.queue[i];
        this.queue[i] = job;
        this.report(old, "superseded", "newer-line-same-session");
        this.wakeConsumer();
        return;
      }
    }

    this.queue.push(job);
    while (this.queue.length > this.maxDepth) {
      const oldest = this.queue.shift()!;
      this.report(oldest, "dropped-stale", "queue-depth-exceeded");
    }
    this.wakeConsumer();
  }

  private wakeConsumer(): void {
    if (this.wake) {
      const w = this.wake;
      this.wake = null;
      w();
    }
  }

  private report(job: PlayJob<T>, disposition: QueueDropDisposition, reason: string): void {
    try {
      this.opts.onDisposition?.(job, disposition, reason);
    } catch {
      // Reporting must never stall the queue.
    }
  }

  private async consume(): Promise<void> {
    while (true) {
      const next = this.queue.shift();
      if (!next) {
        await new Promise<void>((resolve) => { this.wake = resolve; });
        continue;
      }

      const now = this.opts.now?.() ?? Date.now();
      if (now - next.receivedAt > this.ageCapMs) {
        this.report(next, "dropped-stale", "age-cap-exceeded");
        continue;
      }

      try {
        await this.opts.player(next);
      } catch (error) {
        try {
          this.opts.onPlayerError?.(next, error);
        } catch {
          // Reporting must never stall the queue.
        }
      }
    }
  }
}
