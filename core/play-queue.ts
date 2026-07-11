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

import { parseBoundedInt, resolveEchoEnv } from "./env";

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
  playerTimeoutMs?: number;
  now?: () => number; // injectable clock for deterministic age-cap/liveness tests
}

export class PlayQueue<T> {
  readonly ageCapMs: number;
  readonly maxDepth: number;
  readonly playerTimeoutMs: number;

  private readonly opts: PlayQueueOptions<T>;
  private readonly queue: PlayJob<T>[] = [];
  private wake: (() => void) | null = null;
  private inFlightSince: number | null = null;

  constructor(opts: PlayQueueOptions<T>) {
    this.opts = opts;
    // Bounded env reads (ECHO_* convention): a NaN/negative/zero override
    // falls back to the default rather than a degenerate value (floors below).
    //
    // Age cap (default 5 min): a STALENESS guard for lines stuck waiting, not
    // a bound tied to any single timeout. It must comfortably exceed one
    // line's worst-case occupancy of the consumer — synthesis retries with
    // adaptive timeouts plus a full playback can approach ~2 minutes — or an
    // ordinary slow line would mass-drop everything 202-acked behind it.
    // Newest-per-session coalescing already bounds the backlog to one line
    // per session, so a generous cap cannot grow the queue.
    this.ageCapMs = opts.ageCapMs
      ?? parseBoundedInt(resolveEchoEnv("ECHO_PLAY_QUEUE_AGE_CAP_MS"), 300_000, 1_000);
    this.maxDepth = opts.maxDepth
      ?? parseBoundedInt(resolveEchoEnv("ECHO_PLAY_QUEUE_MAX_DEPTH"), 20, 1);
    // Watchdog (default 2 min): liveness is ENFORCED by the queue, not
    // borrowed from the player. Every subprocess in the speak path is
    // process-timeout-bounded, so a player exceeding this is wedged in
    // non-subprocess work; the queue reports it via onPlayerError and
    // advances. (The abandoned player promise is detached, not cancelled —
    // its own bounded subprocesses are already dead by this point.)
    this.playerTimeoutMs = opts.playerTimeoutMs
      ?? parseBoundedInt(resolveEchoEnv("ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS"), 120_000, 1_000);
    void this.consume();
  }

  /** Queued (not in-flight) job count. */
  get depth(): number {
    return this.queue.length;
  }

  /** How long the current job has been playing, or null when idle (liveness). */
  get inFlightMs(): number | null {
    if (this.inFlightSince === null) return null;
    return (this.opts.now?.() ?? Date.now()) - this.inFlightSince;
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

      // One catch-all per job: nothing inside (an injected now(), the age
      // check, the player, the watchdog) may kill this loop — a dead consumer
      // would silently end global playback while /notify keeps acking 202.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      try {
        const now = this.opts.now?.() ?? Date.now();
        if (now - next.receivedAt > this.ageCapMs) {
          this.report(next, "dropped-stale", "age-cap-exceeded");
          continue;
        }
        this.inFlightSince = this.opts.now?.() ?? Date.now();
        const playing = this.opts.player(next);
        // A player that outlives the watchdog is abandoned; keep its eventual
        // rejection handled so it can never surface as an unhandled rejection.
        playing.catch(() => {});
        await Promise.race([
          playing,
          new Promise<never>((_, reject) => {
            watchdog = setTimeout(
              () => reject(new Error(`player watchdog: job exceeded ${this.playerTimeoutMs}ms`)),
              this.playerTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        try {
          this.opts.onPlayerError?.(next, error);
        } catch {
          // Reporting must never stall the queue.
        }
      } finally {
        clearTimeout(watchdog);
        this.inFlightSince = null;
      }
    }
  }
}
