// Wire types for the echo-converse capability.
//
// A turn is a lease, not a single call. The coordinator books the microphone,
// speaks the question through core and waits for playback to drain; the CALLER
// then captures, because macOS attributes the microphone grant to the process
// ancestry that opens it and only the host's own tree reaches the terminal app
// the human granted (see docs/converse.md). So the shape is:
//
//   POST /turn              -> booked, question spoken, capture cleared to open
//   (caller records + transcribes in its own process tree)
//   POST /turn/:id/complete -> booking released
//   POST /turn/:id/abort    -> booking released, failure recorded
//
// The transcript is deliberately absent from every response above: it never
// leaves the process that captured it.

/**
 * The capture-state contract's states, as core/capture-guard.ts defines them.
 * Declared here rather than in the writer so the coordinator never reaches the
 * writer at all, not even for a type (tests/converse/architecture-invariants).
 */
export type CaptureState = "idle" | "recording" | "transcribing";

/** The subset of core's GET /health that converse depends on. */
export interface CoreHealthSnapshot {
  mute: { muted: boolean; muted_until: string | null };
  capture_guard: { path: string | null; state: CaptureState };
  capture_reservation?: { held: boolean; request_id?: string };
  play_queue: { depth: number; in_flight_ms: number | null; stalled: boolean };
}

export interface TurnRequest {
  question: string;
  /** The process that will own the capture, and whose pid goes in the state file. */
  owner_pid: number;
  source?: string;
  voice_id?: string;
  title?: string;
  lease_ms?: number;
  /** Resolved process ancestry, recorded as TCC-attribution evidence. */
  ancestry?: string[];
}

export interface SpokenQuestionReport {
  notify_status: number;
  drained: boolean;
  completion_state?: "completed";
  waited_ms: number;
  polls: number;
}

export interface TurnGrant {
  turn_id: string;
  state: "capture_ready";
  /** The file core told us it reads. The caller writes exactly this path. */
  capture_state_path: string;
  spoke: SpokenQuestionReport;
  capture_reservation_id?: string;
  lease: { owner_pid: number; expires_at: string };
}

export type ConverseErrorCode =
  | "invalid_request"
  | "microphone_busy"
  | "core_unreachable"
  | "core_rate_limited"
  | "core_muted"
  | "capture_guard_disabled"
  | "question_not_spoken"
  | "coordinator_error"
  | "unknown_turn";

export interface ConverseError {
  error: ConverseErrorCode;
  detail: string;
  held_by?: { turn_id: string; owner_pid: number; source: string; acquired_at: string } | null;
}

export interface TurnCompletion {
  /** Metadata only. The transcript itself is never sent to the coordinator. */
  engine?: string;
  capture_ms?: number;
  transcript_chars?: number;
}
