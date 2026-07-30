// The echo-converse coordinator: a microphone-free booking and sequencing surface.
//
// What it owns: the single-microphone booking, speaking the question through
// core and waiting for core's verdict on that line. What it deliberately does
// NOT own: the microphone. A TCC spike on macOS 26.5.2 proved why - a capture opened from a
// launchd background job gets no responsible process ("Failed to fetch
// responsible file descriptor"), no prompt surface and no usable grant, while
// the same capture spawned from the host terminal's process tree attributes
// cleanly to the terminal app the human already granted. So this process books
// the microphone and the CALLER opens it, which is why a turn is a lease rather
// than a single blocking call. `converse/client.ts` puts the blocking one-shot
// ask back on top of that lease.
//
// What holds the mic-free property, stated precisely, because the earlier
// "mechanically enforced" wording was an overclaim and a reviewer was right to
// reject it: tests/converse/architecture-invariants.test.ts is a SOURCE SCAN. It
// fails if this file imports a capture module or spawns any subprocess, which
// catches the regressions people actually write. It is not runtime enforcement,
// and it cannot see a dynamic import, a dependency that spawns on its own, or a
// helper whose name it does not recognise. There is no runtime assertion here
// that this process never opens an audio device.
//
// Exported as a factory. `core/server.ts` exports a started singleton, and
// sharing one across Bun's module cache is the documented cause of the #47 test
// flake, so every caller here starts and stops its own instance.

import type { Server } from "bun";
import {
  acquireBooking,
  readBooking,
  releaseBooking,
  renewBooking,
  type BookingRecord,
} from "./booking.ts";
import type { ConverseConfig } from "./config.ts";
import {
  assessCore,
  readCoreHealth,
  speakQuestion,
  type FetchLike,
} from "./playback.ts";
import type { ConverseError, ConverseErrorCode, TurnGrant, TurnRequest } from "./types.ts";

const MAX_QUESTION_CHARS = 1_000;

/**
 * Slack over the operation budget, covering the coordinator's own round trips
 * (preflight, speaking the question, the completion wait) plus the caller's
 * bookkeeping call at the end.
 */
const LEASE_SLACK_MS = 30_000;

export interface ConverseServerOptions {
  config: ConverseConfig;
  /** Overridden in tests so no test ever reaches the operator's running daemon. */
  fetchImpl?: FetchLike;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
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

/**
 * The budget an ask can actually consume: the capture cap plus the single
 * transcription-phase cap, which are the only bounded steps a turn has.
 */
function operationBudgetMs(config: ConverseConfig): number {
  return config.maxCaptureMs + config.transcribeTimeoutMs;
}

/**
 * Resolve the lease, or refuse.
 *
 * The old behavior clamped any requested lease to a hardcoded ten minutes, which
 * silently converted an honest request into a booking that expired while the
 * operation it protected was still running - and an expired booking is one a
 * second ask can take over (F5). Both directions are now refusals with names:
 * too short to cover the operation, or longer than this coordinator's own
 * configuration could ever need. Neither is quietly adjusted.
 */
function resolveLease(
  requested: unknown,
  config: ConverseConfig,
): { ok: true; leaseMs: number } | { ok: false; code: ConverseErrorCode; detail: string } {
  const budget = operationBudgetMs(config);
  const ceiling = budget + LEASE_SLACK_MS;

  if (requested === undefined) return { ok: true, leaseMs: ceiling };
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return { ok: false, code: "invalid_request", detail: "lease_ms must be a finite number" };
  }

  const leaseMs = Math.floor(requested);
  if (leaseMs < budget) {
    return {
      ok: false,
      code: "lease_too_short",
      detail:
        `a lease of ${leaseMs}ms cannot cover this coordinator's operation budget of ${budget}ms ` +
        `(capture ${config.maxCaptureMs}ms + transcription ${config.transcribeTimeoutMs}ms), so the ` +
        "booking could expire while the microphone was still open",
    };
  }
  if (leaseMs > ceiling) {
    return {
      ok: false,
      code: "lease_unsupported",
      detail:
        `a lease of ${leaseMs}ms exceeds what this coordinator can honor (${ceiling}ms: operation ` +
        `budget ${budget}ms plus ${LEASE_SLACK_MS}ms slack). Align ECHO_CONVERSE_MAX_CAPTURE_MS and ` +
        "ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS across the caller and the coordinator rather than asking " +
        "for a longer reservation than the work can need.",
    };
  }
  return { ok: true, leaseMs };
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
      capture_state_path: typeof raw.capture_state_path === "string" ? raw.capture_state_path : undefined,
      capture_nonce: typeof raw.capture_nonce === "string" ? raw.capture_nonce : undefined,
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

  const active = new Map<string, ActiveTurn>();
  const counts = { completed: 0, aborted: 0, refused: 0 };

  /** Abandoned turns are dropped here rather than by a timer, so nothing leaks and no interval outlives a test. */
  function dropExpiredTurns(at: number): void {
    for (const [id, turn] of active) {
      if (turn.expires_at <= at) {
        active.delete(id);
        counts.aborted++;
        log(`turn ${id} expired without completing`);
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
    dropExpiredTurns(startedAt);

    // Resolved BEFORE the booking is taken: a refusal here must not have to
    // release anything.
    const lease = resolveLease(request.lease_ms, config);
    if (!lease.ok) {
      counts.refused++;
      log(`turn refused: ${lease.code} (${lease.detail})`);
      return fail(lease.code, lease.detail, 400);
    }
    const leaseMs = lease.leaseMs;
    const turnId = newTurnId();

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
    if (booking.reaped) log(`reaped abandoned booking ${booking.reaped.turn_id} (pid ${booking.reaped.owner_pid})`);

    // Everything from here to the grant runs under ONE finally. A booking that
    // outlives its turn locks out every later ask until the lease expires, and
    // the ways to reach that are not all graceful returns: a core socket reset,
    // a malformed core response, or any unforeseen throw used to strand the lock
    // (F1). So the release is unconditional and keyed on whether the turn was
    // actually granted, rather than repeated on each refusal path.
    let granted = false;
    const refuse = (code: ConverseErrorCode, detail: string, status: number): Response => {
      counts.refused++;
      log(`turn ${turnId} refused: ${code} (${detail})`);
      return fail(code, detail, status);
    };

    try {
    const assessment = assessCore(await readCoreHealth(config.coreBaseUrl, fetchImpl), {
      ownerPid: request.owner_pid,
      expectedCapturePath: request.capture_state_path,
    });
    if (!assessment.ok) {
      return refuse(assessment.code, assessment.detail, assessment.code === "microphone_busy" ? 409 : 503);
    }

    // Speak the question and wait for core's verdict on THIS question. The
    // caller's hold is already up (it published before asking), so the question
    // carries the caller's nonce or core would silence the very line it is
    // holding for.
    const spokeAt = now();
    const spoken = await speakQuestion({
      coreBaseUrl: config.coreBaseUrl,
      question: request.question,
      turnId,
      voiceId: request.voice_id,
      title: request.title,
      source: request.source,
      captureNonce: request.capture_nonce,
      fetchImpl,
    });
    if (spoken.status < 200 || spoken.status >= 300) {
      return refuse("question_not_spoken", `core answered HTTP ${spoken.status} to /notify`, 503);
    }
    // `played` is the only outcome that clears a microphone to open. Everything
    // else means the human never heard the question, and recording them against
    // a question they did not hear is the failure this whole path exists to
    // prevent - so it is a refusal, not a warning.
    if (spoken.disposition !== "played") {
      return refuse(
        "question_not_spoken",
        `core reported the question as "${spoken.disposition}" rather than played, so the human did not hear it`,
        503,
      );
    }

    // The lease clock starts HERE, at the grant, not when the request arrived.
    // The lease bounds the phase where the microphone is open, and the
    // microphone is not open while the question plays - that phase is bounded by
    // core's own watchdog-derived cap on `await_playback`. Charging the speak
    // time to the capture budget would let a question queued behind other lines
    // consume the whole lease before capture began, which is F5's failure mode
    // wearing a different hat. The booking is re-based to match, or it would
    // stay reapable on the old clock while the recording ran.
    const grantedAt = now();
    const expiresAt = grantedAt + leaseMs;
    renewBooking(config.bookingLockPath, turnId, expiresAt);

    active.set(turnId, {
      turn_id: turnId,
      owner_pid: request.owner_pid,
      source: request.source ?? "unknown",
      question_chars: request.question.length,
      started_at: startedAt,
      expires_at: expiresAt,
      ancestry: request.ancestry ?? [],
    });
    log(`turn ${turnId} ready for capture (owner pid ${request.owner_pid}, source ${request.source})`);

    const grant: TurnGrant = {
      turn_id: turnId,
      state: "capture_ready",
      capture_state_path: assessment.capture_state_path,
      spoke: {
        notify_status: spoken.status,
        disposition: spoken.disposition,
        waited_ms: now() - spokeAt,
      },
      lease: {
        owner_pid: request.owner_pid,
        expires_at: new Date(expiresAt).toISOString(),
      },
    };
    granted = true;
    return json(grant, 200);
    } finally {
      // The turn owns the booking only if it was granted. Every other exit,
      // refusal or throw alike, hands the microphone straight back.
      if (!granted) releaseBooking(config.bookingLockPath, turnId);
    }
  }

  function finishTurn(turnId: string, outcome: "completed" | "aborted", detail: string): Response {
    const turn = active.get(turnId);
    if (!turn) {
      // A turn dropped for outliving its lease still owns the lock file, and its
      // caller is the only one who can hand the microphone back. releaseBooking
      // refuses when the holder is a different turn, so this cannot take a lock
      // away from a live one.
      releaseBooking(config.bookingLockPath, turnId);
      return fail("unknown_turn", `no active turn ${turnId}`, 404);
    }

    active.delete(turnId);
    releaseBooking(config.bookingLockPath, turnId);
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
      try {
        return await route(req);
      } catch (thrown) {
        // Bun's default error page is HTML, and the client reads coordinator
        // responses with response.json(); an unforeseen fault would surface to
        // the caller as a parse error instead of a cause (F1). Every answer this
        // server gives is machine-readable, including the ones nobody planned.
        const detail = thrown instanceof Error ? thrown.message : String(thrown);
        log(`unhandled coordinator error: ${detail}`);
        return fail("coordinator_error", detail, 500);
      }
    },
  });

  async function route(req: Request): Promise<Response> {
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
  }

  const handle: ConverseServerHandle = {
    port: server.port ?? 0,
    stop: () => void server.stop(true),
    activeTurns: () => [...active.values()],
  };
  return handle;
}
