// The one-shot ask, as callers see it: one question in, one transcript out.
//
// The blocking turn lives here rather than in the coordinator because the
// microphone has to be opened by the caller. macOS attributes a microphone
// grant to the responsible process, and the TCC spike showed the two outcomes
// plainly: a capture spawned inside the host terminal's process tree attributed
// to the terminal app the human already granted, while the same capture under a
// background service got no responsible process and no usable grant. So the
// coordinator leases the microphone and this module redeems the lease in the
// host's own tree.
//
// The resulting sequence, which is also the answer to the self-hold trap:
//
//   POST /turn      -> coordinator books, speaks the question, waits for drain
//   write recording -> only now, so core never holds back its own question
//   capture child   -> spawned here, in the caller's ancestry
//   write idle      -> unconditionally, in a finally
//   POST complete   -> booking released; metadata only, never the transcript

import { captureAndTranscribe, CaptureError, type CaptureEngine } from "./capture.ts";
import { resolveConverseConfig, type ConverseConfig, type SttTier } from "./config.ts";
import { withCaptureHeld } from "./capture-state.ts";
import type { SpokenQuestionReport, TurnGrant } from "./types.ts";

const COORDINATOR_START_TIMEOUT_MS = 5_000;
const COORDINATOR_POLL_MS = 100;
/** Slack over the capture cap so a lease cannot expire mid-recording. */
const LEASE_SLACK_MS = 30_000;
const MAX_ANCESTRY_DEPTH = 12;

export interface AskOptions {
  question: string;
  /** Host tag recorded by both daemons ("pi", "omp", "claudecode"). */
  source?: string;
  voiceId?: string;
  title?: string;
}

export interface AskResult {
  /** The raw transcript. No polish pass in v1. */
  text: string;
  turn_id: string;
  engine: SttTier;
  capture_ms: number;
  spoke: SpokenQuestionReport;
  /** Process chain that opened the microphone, as TCC-attribution evidence. */
  ancestry: string[];
}

export class AskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AskError";
  }
}

export interface AskDeps {
  config?: ConverseConfig;
  captureEngine?: CaptureEngine;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Injected in tests so auto-start can be exercised or suppressed. */
  startCoordinator?: (config: ConverseConfig) => void;
  sleep?: (ms: number) => Promise<void>;
  ancestry?: string[];
}

interface ProcessEntry {
  ppid: number;
  comm: string;
}

function readProcessTable(): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  const result = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,comm="]);
  if (!result.success) return table;
  for (const line of result.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3].trim() });
  }
  return table;
}

/**
 * Walk parents from `pid` upward. The chain is reported, not enforced: it turns
 * "capture happens in the host's process tree" from an assumption into something
 * an operator can read back out of a turn.
 */
export function resolveAncestry(
  pid: number = process.pid,
  table: Map<number, ProcessEntry> = readProcessTable(),
): string[] {
  const chain: string[] = [];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    const entry = table.get(current);
    if (!entry) break;
    chain.push(`${current} ${entry.comm}`);
    if (entry.ppid <= 1) break;
    current = entry.ppid;
  }
  return chain;
}

function spawnCoordinator(config: ConverseConfig): void {
  const main = process.env.ECHO_CONVERSE_MAIN || new URL("./main.ts", import.meta.url).pathname;
  const child = Bun.spawn(["bun", main], {
    // The coordinator outlives this call but must never hold the host session
    // open, and its output belongs in the host's log, not in a tool result.
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, ECHO_CONVERSE_PORT: String(config.port) },
  });
  child.unref();
}

async function coordinatorIsUp(config: ConverseConfig, fetchImpl: NonNullable<AskDeps["fetchImpl"]>): Promise<boolean> {
  try {
    const response = await fetchImpl(`${config.baseUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure a coordinator is listening, starting one if not.
 *
 * There is no LaunchAgent for this capability on purpose: an always-on service
 * is the topology the TCC spike ruled out, and starting on demand keeps the
 * coordinator's lifetime tied to actual use. Losing the start race is fine -
 * whoever bound the port first is the coordinator, and this just waits for it.
 */
export async function ensureCoordinator(
  config: ConverseConfig,
  deps: Pick<AskDeps, "fetchImpl" | "startCoordinator" | "sleep"> = {},
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (await coordinatorIsUp(config, fetchImpl)) return;

  (deps.startCoordinator ?? spawnCoordinator)(config);

  // Attempts rather than a wall-clock deadline, so an injected no-op sleep in a
  // test finishes immediately instead of spinning for the real timeout.
  const attempts = Math.ceil(COORDINATOR_START_TIMEOUT_MS / COORDINATOR_POLL_MS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(COORDINATOR_POLL_MS);
    if (await coordinatorIsUp(config, fetchImpl)) return;
  }
  throw new AskError(
    "coordinator_unavailable",
    `no echo-converse coordinator on ${config.baseUrl} after ${COORDINATOR_START_TIMEOUT_MS}ms`,
  );
}

/**
 * Ask the human a question out loud and return what they said.
 *
 * Blocks for the whole turn. The caller is the microphone owner: its pid is what
 * core's capture guard probes, so a crash here frees core immediately rather
 * than leaving the operator silently muted.
 */
export async function askOnce(options: AskOptions, deps: AskDeps = {}): Promise<AskResult> {
  const config = deps.config ?? resolveConverseConfig();
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const captureEngine = deps.captureEngine ?? captureAndTranscribe;

  const question = options.question.trim();
  if (question.length === 0) throw new AskError("invalid_request", "question must not be empty");

  await ensureCoordinator(config, deps);

  const ancestry = deps.ancestry ?? resolveAncestry();
  const response = await fetchImpl(`${config.baseUrl}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      owner_pid: process.pid,
      source: options.source ?? "unknown",
      voice_id: options.voiceId,
      title: options.title,
      lease_ms: config.maxCaptureMs + LEASE_SLACK_MS,
      ancestry,
    }),
  });

  const body = (await response.json()) as TurnGrant & { error?: string; detail?: string };
  if (!response.ok) {
    throw new AskError(body.error ?? `http_${response.status}`, body.detail ?? `coordinator answered ${response.status}`);
  }

  const finish = async (verb: "complete" | "abort", payload: Record<string, unknown>) => {
    try {
      await fetchImpl(`${config.baseUrl}/turn/${body.turn_id}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // The booking's lease and owner-liveness reaping already cover a lost
      // release, and failing the ask because the bookkeeping call failed would
      // discard a transcript the human already spoke.
    }
  };

  try {
    // The capture state goes to `recording` only now, after the coordinator has
    // confirmed the question finished playing.
    // `recording` covers the transcriber too. Core holds its speech on
    // `recording` and `transcribing` alike, so splitting the phases here would
    // add a write that changes nothing core does.
    const captured = await withCaptureHeld(body.capture_state_path, () => captureEngine(config));

    await finish("complete", {
      engine: captured.engine,
      capture_ms: captured.capture_ms,
      transcript_chars: captured.text.length,
    });

    return {
      text: captured.text,
      turn_id: body.turn_id,
      engine: captured.engine,
      capture_ms: captured.capture_ms,
      spoke: body.spoke,
      ancestry,
    };
  } catch (error) {
    const code = error instanceof CaptureError ? error.code : "capture_failed";
    await finish("abort", { reason: `${code}: ${error instanceof Error ? error.message : String(error)}` });
    throw error instanceof CaptureError
      ? new AskError(code, error.message)
      : new AskError("capture_failed", error instanceof Error ? error.message : String(error));
  }
}
