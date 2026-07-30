// The echo-converse coordinator: a microphone-free booking and sequencing surface.
//
// What it owns: the single-microphone booking, speaking the question through
// core, and observing exact per-request playback completion. What it deliberately does NOT own: the
// microphone. A TCC spike on macOS 26.5.2 proved why - a capture opened from a
// launchd background job gets no responsible process ("Failed to fetch
// responsible file descriptor"), no prompt surface and no usable grant, while
// the same capture spawned from the host terminal's process tree attributes
// cleanly to the terminal app the human already granted. So this process books
// the microphone and the CALLER opens it, which is why a turn is a lease rather
// than a single blocking call. `converse/client.ts` puts the blocking one-shot
// ask back on top of that lease.
//
// The mic-free property is a source boundary: tests/converse/architecture-invariants
// catches direct imports, subprocess calls and simple transitive regressions. It is
// not runtime enforcement of every possible indirect dependency behavior.
//
// Exported as a factory. `core/server.ts` exports a started singleton, and
// sharing one across Bun's module cache is the documented cause of the #47 test
// flake, so every caller here starts and stops its own instance.

import type { Server } from "bun";
import {
  acquireBooking,
  readBooking,
  releaseBooking,
  type BookingRecord,
} from "./booking.ts";
import { CONVERSE_LEASE_SLACK_MS, type ConverseConfig } from "./config.ts";
import {
  assessCore,
  estimateSpeechMs,
  readCoreHealth,
  realSleep,
  speakQuestion,
  waitForPlaybackCompletion,
  type FetchLike,
  type SleepLike,
} from "./playback.ts";
import type { ConverseError, ConverseErrorCode, TurnGrant, TurnRequest } from "./types.ts";

const MAX_QUESTION_CHARS = 1_000;
const MIN_LEASE_MS = 10_000;
const RELEASE_ATTEMPTS = 2;
const RELEASE_RETRY_DELAY_MS = 250;

export interface ConverseServerOptions {
  config: ConverseConfig;
  /** Overridden in tests so no test ever reaches the operator's running daemon. */
  fetchImpl?: FetchLike;
  sleep?: SleepLike;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  pollIntervalMs?: number;
  maxPolls?: number;
  log?: (line: string) => void;
  /** 0 binds an ephemeral port; tests use it so they can never collide. */
  port?: number;
}

interface ActiveTurn {
  turn_id: string;
  owner_pid: number;
  source: string;
  question_chars: number;
  started_at: number;
  expires_at: number;
  ancestry: string[];
  capture_reservation_id: string;
}

export interface ConverseServerHandle {
  port: number;
  stop(): void;
  /** Read-only view for tests and diagnostics. */
  activeTurns(): ActiveTurn[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fail(code: ConverseErrorCode, detail: string, status: number, extra: Partial<ConverseError> = {}): Response {
  return json({ error: code, detail, ...extra }, status);
}

function heldByView(record: BookingRecord | null) {
  return record === null
    ? null
    : {
        turn_id: record.turn_id,
        owner_pid: record.owner_pid,
        source: record.source,
        acquired_at: record.acquired_at,
      };
}

function clampLease(requested: unknown, fallback: number, maximum: number): number {
  const value = typeof requested === "number" && Number.isFinite(requested) ? requested : fallback;
  return Math.min(Math.max(Math.floor(value), MIN_LEASE_MS), Math.max(MIN_LEASE_MS, maximum));
}

function validateTurnRequest(body: unknown, isPidAlive: (pid: number) => boolean): { ok: true; request: TurnRequest } | { ok: false; detail: string } {
  if (typeof body !== "object" || body === null) return { ok: false, detail: "body must be a JSON object" };
  const raw = body as Record<string, unknown>;

  const question = raw.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return { ok: false, detail: "question must be a non-empty string" };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return { ok: false, detail: `question must be at most ${MAX_QUESTION_CHARS} characters` };
  }

  const ownerPid = raw.owner_pid;
  if (typeof ownerPid !== "number" || !Number.isInteger(ownerPid) || ownerPid <= 0) {
    return { ok: false, detail: "owner_pid must be a positive integer" };
  }
  // The owner pid is what core's capture guard probes for liveness. A dead or
  // invented pid would publish a capture state core ignores, so the recording
  // would happen with core still free to speak into it.
  if (!isPidAlive(ownerPid)) {
    return { ok: false, detail: `owner_pid ${ownerPid} is not a live process` };
  }

  return {
    ok: true,
    request: {
      question: question.trim(),
      owner_pid: ownerPid,
      source: typeof raw.source === "string" ? raw.source : "unknown",
      voice_id: typeof raw.voice_id === "string" ? raw.voice_id : undefined,
      title: typeof raw.title === "string" ? raw.title : undefined,
      lease_ms: typeof raw.lease_ms === "number" ? raw.lease_ms : undefined,
      ancestry: Array.isArray(raw.ancestry) ? raw.ancestry.filter((entry): entry is string => typeof entry === "string") : [],
    },
  };
}

export function createConverseServer(options: ConverseServerOptions): ConverseServerHandle {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now;
  const isPidAlive = options.isPidAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? realSleep;

  const active = new Map<string, ActiveTurn>();
  const counts = { completed: 0, aborted: 0, refused: 0 };

  /**
   * Abandoned turns are dropped here rather than by a timer, so nothing leaks and
   * no interval outlives a test. Dropping the bookkeeping is not enough: an
   * expired turn still holds the microphone booking AND core's capture
   * reservation, and its caller is gone, so this is the only place either gets
   * handed back.
   */
  async function dropExpiredTurns(at: number): Promise<void> {
    for (const [id, turn] of active) {
      if (turn.expires_at <= at) {
        active.delete(id);
        counts.aborted++;
        log(`turn ${id} expired without completing`);
        await cleanupTurn(turn);
      }
    }
  }

  function newTurnId(): string {
    return `t-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function handleTurn(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail("invalid_request", "body must be valid JSON", 400);
    }

    const validated = validateTurnRequest(body, isPidAlive);
    if (!validated.ok) {
      counts.refused++;
      return fail("invalid_request", validated.detail, 400);
    }
    const request = validated.request;

    const startedAt = now();
    await dropExpiredTurns(startedAt);

    const leaseBudgetMs = config.maxCaptureMs + config.transcribeTimeoutMs + CONVERSE_LEASE_SLACK_MS;
    const leaseMs = clampLease(request.lease_ms, config.leaseMs, leaseBudgetMs);
    const turnId = newTurnId();

    let bookingAcquired = false;
    let handedOff = false;
    try {
      // Book first. Two asks arriving together must not both get as far as
      // speaking: the human would hear two questions and answer one recording.
      const booking = acquireBooking({
        path: config.bookingLockPath,
        turnId,
        ownerPid: request.owner_pid,
        source: request.source ?? "unknown",
        leaseMs,
        now,
        isPidAlive,
      });
      if (!booking.ok) {
        counts.refused++;
        return fail("microphone_busy", "another turn holds the microphone", 409, {
          held_by: heldByView(booking.held_by),
        });
      }
      bookingAcquired = true;
      if (booking.reaped) log(`reaped abandoned booking ${booking.reaped.turn_id} (pid ${booking.reaped.owner_pid})`);

      const assessment = assessCore(await readCoreHealth(config.coreBaseUrl, fetchImpl));
      if (!assessment.ok) {
        counts.refused++;
        log(`turn ${turnId} refused: ${assessment.code} (${assessment.detail})`);
        return fail(assessment.code, assessment.detail, assessment.code === "microphone_busy" ? 409 : 503);
      }

      // Speak while the capture state is still idle. Publishing `recording` first
      // would make core's own guard hold back the question converse just asked it
      // to speak, and the human would be recorded against silence.
      const spoken = await speakQuestion({
        coreBaseUrl: config.coreBaseUrl,
        question: request.question,
        turnId,
        voiceId: request.voice_id,
        title: request.title,
        source: request.source,
        ownerPid: request.owner_pid,
        leaseMs,
        fetchImpl,
      });
      if (spoken.status < 200 || spoken.status >= 300 || spoken.requestId === undefined) {
        counts.refused++;
        const detail = spoken.requestId === undefined && spoken.status >= 200 && spoken.status < 300
          ? "core accepted /notify without a request_id completion token"
          : `core answered HTTP ${spoken.status} to /notify`;
        log(`turn ${turnId} refused: question_not_spoken (${detail})`);
        return fail("question_not_spoken", detail, 503);
      }

      const completion = await waitForPlaybackCompletion({
        coreBaseUrl: config.coreBaseUrl,
        requestId: spoken.requestId,
        estimateMs: estimateSpeechMs(request.question),
        fetchImpl,
        sleep: options.sleep,
        pollIntervalMs: options.pollIntervalMs,
        maxPolls: options.maxPolls,
      });
      if (!completion.completed || completion.capture_reservation_id === undefined) {
        // Name the cause the operator can act on. Out of readings and out of queue
        // are the same symptom with opposite fixes, and the rate-limit case is the
        // likely one: the turn has already spent several requests on core.
        const detail = completion.detail ?? (completion.refused_reads === completion.polls
          ? `core refused every completion reading (${completion.polls} of ${completion.polls}, rate limit or unreachable), ` +
            "so whether this question finished playing is unknown"
          : `this question did not report playback completion within ${completion.waited_ms}ms`);
        counts.refused++;
        log(`turn ${turnId} refused: question_not_spoken (${detail})`);
        return fail("question_not_spoken", detail, 503);
      }

      const grant: TurnGrant = {
        turn_id: turnId,
        state: "capture_ready",
        capture_state_path: assessment.capture_state_path,
        spoke: {
          notify_status: spoken.status,
          drained: completion.completed,
          completion_state: "completed",
          waited_ms: completion.waited_ms,
          polls: completion.polls,
        },
        capture_reservation_id: completion.capture_reservation_id,
        lease: {
          owner_pid: request.owner_pid,
          expires_at: new Date(startedAt + leaseMs).toISOString(),
        },
      };
      // Serialize before handing the lock to the caller. A serialization failure
      // must still take the booking through the failure path below.
      const response = json(grant, 200);
      active.set(turnId, {
        turn_id: turnId,
        owner_pid: request.owner_pid,
        source: request.source ?? "unknown",
        question_chars: request.question.length,
        started_at: startedAt,
        expires_at: startedAt + leaseMs,
        ancestry: request.ancestry ?? [],
        capture_reservation_id: completion.capture_reservation_id,
      });
      handedOff = true;
      log(`turn ${turnId} ready for capture (owner pid ${request.owner_pid}, source ${request.source})`);
      return response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unexpected coordinator failure";
      const code: ConverseErrorCode = bookingAcquired ? "question_not_spoken" : "coordinator_error";
      const status = bookingAcquired ? 503 : 500;
      if (!handedOff) {
        counts.refused++;
        log(`turn ${turnId} refused: ${code} (${detail})`);
      }
      return fail(code, detail, status);
    } finally {
      if (bookingAcquired && !handedOff) releaseBooking(config.bookingLockPath, turnId);
    }
  }

  /**
   * Hand core's reservation back, and say so when that fails. While core holds
   * one it skips EVERY voice line, so an unnoticed non-2xx (a 429 from a busy
   * turn, a 404 from a reservation that never activated) is the operator's Echo
   * going silent for the rest of the lease. One retry covers the transient case;
   * beyond that the lease and the owner-liveness guard are the backstop, and the
   * log names it rather than reporting success.
   */
  async function releaseCoreReservation(turn: ActiveTurn): Promise<void> {
    const url = `${config.coreBaseUrl}/notify/${encodeURIComponent(turn.capture_reservation_id)}/capture-release`;
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
      let detail: string;
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        // 404 means core is not holding this reservation, which is the same
        // end state as a successful release.
        if (response.status === 200 || response.status === 404) return;
        detail = `core answered HTTP ${response.status}`;
      } catch (error) {
        detail = error instanceof Error ? error.message : "core unreachable";
      }
      log(`turn ${turn.turn_id} capture-release attempt ${attempt} failed: ${detail}`);
      if (attempt < RELEASE_ATTEMPTS) await sleep(RELEASE_RETRY_DELAY_MS);
    }
    log(
      `turn ${turn.turn_id} could not release core reservation ${turn.capture_reservation_id}; ` +
        "core stays silent until its lease expires",
    );
  }

  /** Every path out of a turn goes through here, so neither hold can be freed without the other. */
  async function cleanupTurn(turn: ActiveTurn): Promise<void> {
    await releaseCoreReservation(turn);
    releaseBooking(config.bookingLockPath, turn.turn_id);
  }

  async function finishTurn(turnId: string, outcome: "completed" | "aborted", detail: string): Promise<Response> {
    const turn = active.get(turnId);
    if (!turn) {
      // A turn dropped for outliving its lease has already had both holds
      // released by dropExpiredTurns; this covers the lock file surviving a
      // coordinator restart. releaseBooking refuses when the holder is a
      // different turn, so this cannot take a lock away from a live one.
      releaseBooking(config.bookingLockPath, turnId);
      return fail("unknown_turn", `no active turn ${turnId}`, 404);
    }

    active.delete(turnId);
    await cleanupTurn(turn);
    if (outcome === "completed") counts.completed++;
    else counts.aborted++;
    log(`turn ${turnId} ${outcome}${detail ? `: ${detail}` : ""}`);

    return json({ turn_id: turnId, state: outcome, duration_ms: now() - turn.started_at });
  }

  function health(): Response {
    const booking = readBooking(config.bookingLockPath);
    return json({
      status: "healthy",
      capability: "echo-converse",
      port: handle.port,
      // Not probed: core's /health shares its /notify rate-limit bucket, so a
      // status check must not spend the operator's notification budget.
      core: { base_url: config.coreBaseUrl },
      booking: { held: booking !== null, held_by: heldByView(booking) },
      turns: { active: active.size, ...counts },
      capture: {
        // Capture is the caller's job; the coordinator never opens the microphone.
        owner: "caller",
        booking_lock: config.bookingLockPath,
      },
    });
  }

  const server: Server = Bun.serve({
    port: options.port ?? config.port,
    // Loopback only. This capability coordinates microphone access; it has no
    // business being reachable from another host.
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") return health();

      if (url.pathname === "/turn" && req.method === "POST") return handleTurn(req);

      const finish = /^\/turn\/([^/]+)\/(complete|abort)$/.exec(url.pathname);
      if (finish && req.method === "POST") {
        const [, turnId, verb] = finish;
        let detail = "";
        try {
          const body = (await req.json()) as Record<string, unknown>;
          detail = typeof body?.reason === "string" ? body.reason : "";
        } catch {
          // Metadata is optional: releasing the microphone must not depend on it.
        }
        return finishTurn(turnId, verb === "complete" ? "completed" : "aborted", detail);
      }

      return json(
        {
          error: "not_found",
          detail: `Unsupported endpoint: ${req.method} ${url.pathname}`,
          supported_endpoints: ["POST /turn", "POST /turn/:id/complete", "POST /turn/:id/abort", "GET /health"],
        },
        404,
      );
    },
  });

  const handle: ConverseServerHandle = {
    port: server.port ?? 0,
    stop: () => void server.stop(true),
    activeTurns: () => [...active.values()],
  };
  return handle;
}
