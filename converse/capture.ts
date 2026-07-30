// Microphone capture and local transcription.
//
// This module is the privileged half of the capability, and it runs ONLY in the
// caller's process, never in the coordinator. macOS attributes a microphone
// grant to the responsible process, and the TCC spike measured both ends of
// that: a capture spawned from the host terminal's tree attributed to the
// terminal app (com.github.wez.wezterm) and delivered live audio, while the same
// capture under a launchd job produced "Failed to fetch responsible file
// descriptor", no grant and no prompt. So capture stays a per-ask child of
// whatever host asked.
//
// Two tiers, both local, no cloud rung:
//
//   capture     rec (sox) with the `silence` effect for endpointing
//   Tier 1 STT  yap transcribe   - Apple SpeechAnalyzer, no model download
//   Tier 2 STT  whisper-cli      - portable, needs a user-supplied model
//
// This splits the plan's Tier 1 row, which assigned "capture + endpoint" to
// `yap dictate`. Installed yap 1.2.1 has no duration, silence or stop flag:
// `dictate` runs until it is killed, so it cannot endpoint a turn. `rec` can,
// the spike already proved it captures from this ancestry, and `yap transcribe`
// stays the Tier 1 transcriber. docs/converse.md records the change.
//
// Recording at the device's native rate is deliberate. VoiceLayer's hard-won
// lesson was that resampling inside the streaming capture path overruns on
// devices that run at unusual rates (AirPods at 24kHz), so the rate conversion
// whisper needs happens afterwards, offline, where an overrun is impossible.

import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConverseConfig, SttTier } from "./config.ts";

/** A capture shorter than this cannot hold speech; sox writes a header-only file when it hears nothing. */
const MIN_AUDIBLE_WAV_BYTES = 1_024;

export interface CaptureEngineResult {
  /** Raw transcript. No polish pass: the calling agent interprets it. */
  text: string;
  engine: SttTier;
  capture_ms: number;
  timed_out: boolean;
}

/** The seam the client is built against, so tests can drive a turn without a microphone. */
export type CaptureEngine = (config: ConverseConfig, signal?: AbortSignal) => Promise<CaptureEngineResult>;

export class CaptureError extends Error {
  constructor(
    readonly code: "cancelled" | "no_recorder" | "no_stt_tier" | "recorder_failed" | "transcriber_failed" | "no_speech",
    message: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

type Which = (bin: string) => string | null;

// An explicit path is checked for existence rather than trusted: a stale
// ECHO_CONVERSE_YAP_BIN should report "no transcriber available", not ENOENT
// from deep inside a turn that has already recorded the human.
const defaultWhich: Which = (bin) => {
  if (!bin.includes("/")) return Bun.which(bin);
  return existsSync(bin) ? bin : null;
};

/**
 * Pick the transcriber. An explicit `ECHO_CONVERSE_STT_TIER` is honored even if
 * the binary is missing, so a misconfiguration reports itself instead of
 * silently transcribing through a rung the operator did not choose.
 */
export function selectSttTier(config: ConverseConfig, which: Which = defaultWhich): SttTier | null {
  if (config.sttTier === "yap") return which(config.yapBin) ? "yap" : null;
  if (config.sttTier === "whisper") return whisperUsable(config, which) ? "whisper" : null;
  if (which(config.yapBin)) return "yap";
  return whisperUsable(config, which) ? "whisper" : null;
}

function whisperUsable(config: ConverseConfig, which: Which): boolean {
  return Boolean(which(config.whisperBin)) && config.whisperModel !== undefined;
}

/**
 * Fail with a name and a fix before spawning, rather than with an ENOENT from
 * inside a turn. This matters most for the recorder: splitting the plan's Tier 1
 * row made sox a Tier 1 dependency, so the very machine the plan pictured (macOS
 * 26 with `brew install yap` and nothing else) is the one that hits it.
 */
function requireBinary(bin: string, code: CaptureError["code"], hint: string, which: Which = defaultWhich): void {
  if (which(bin) === null) {
    throw new CaptureError(code, `${bin} is not available. ${hint}`);
  }
}

/** whisper takes a bare language code; the configured locale is BCP-47. */
function whisperLanguage(locale: string): string {
  return locale.split("-")[0] || "en";
}

export function recorderArgv(config: ConverseConfig, wavPath: string): string[] {
  const silenceSeconds = (config.silenceMs / 1_000).toFixed(2);
  return [
    "-q",
    "-c", "1",
    "-b", "16",
    wavPath,
    // Trim the lead-in until 0.1s rises above the noise floor, then stop once
    // the configured trailing silence has passed: the human stops talking and
    // the turn ends without them pressing anything.
    "silence", "1", "0.1", "2%", "1", silenceSeconds, "2%",
  ];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CaptureError("cancelled", "the ask was cancelled during capture");
}

interface PipeCollector {
  /** Everything read before the pipe ended or the read was abandoned. */
  text: Promise<string>;
  abandon: () => void;
}

/**
 * Start reading a child's pipe immediately, while it is still running.
 *
 * Waiting for exit before reading deadlocks a chatty child: a transcriber that
 * fills the pipe buffer blocks on write and never exits, so the process this is
 * waiting on can only exit once somebody drains it.
 */
function drainPipe(stream: ReadableStream<Uint8Array>): PipeCollector {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  const text = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) collected += decoder.decode(value, { stream: true });
      }
    } catch {
      // A cancelled or broken pipe yields what was read up to that point.
    }
    return collected + decoder.decode();
  })();
  return { text, abandon: () => void reader.cancel().catch(() => {}) };
}

/**
 * Collect what a finished child wrote, without being able to hang on it.
 *
 * Waiting for end-of-stream is not safe here: a killed recorder can leave a
 * grandchild holding the same pipe open, and the read would then outlive the
 * process it was reading. Cancelling the reader settles the collector with
 * whatever it already had, so the grace period costs output nobody sent.
 */
async function collectWithin(collector: PipeCollector, graceMs: number): Promise<string> {
  const timer = setTimeout(collector.abandon, graceMs);
  try {
    return await collector.text;
  } finally {
    clearTimeout(timer);
  }
}

const OUTPUT_GRACE_MS = 500;

/** Grace between SIGTERM and SIGKILL for a child whose cap must be hard. */
const HARD_KILL_GRACE_MS = 2_000;

interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Escalate to SIGKILL this long after the cap's SIGTERM. Without it the cap is
   * only as strong as the child's signal handling, which is the right trade for
   * the recorder and the wrong one for the transcriber (see the call sites).
   */
  hardKillAfterMs?: number;
}

async function run(
  cmd: string[],
  options: RunOptions = {},
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const { timeoutMs, signal, hardKillAfterMs } = options;
  // The recorder creates the WAV itself. Give every capture child a private
  // umask at creation time; recordReply also chmods the finished artifact to
  // close the gap for a child that deliberately changes its own umask.
  const previousUmask = process.umask(0o077);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  } finally {
    process.umask(previousUmask);
  }
  // Drain from the moment the child exists; the grace timer is armed only once
  // it has exited, so a slow-but-healthy child is never truncated.
  const outCollector = drainPipe(child.stdout);
  const errCollector = drainPipe(child.stderr);
  let timedOut = false;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        // SIGTERM first, always: sox finalizes the WAV header on a caught signal,
        // and a truncated header is an unreadable recording. Verified on macOS
        // 26.5.2 - a recorder stopped at the cap still yields a readable file.
        child.kill("SIGTERM");
        if (hardKillAfterMs !== undefined) {
          hardTimer = setTimeout(() => child.kill("SIGKILL"), hardKillAfterMs);
        }
      }, timeoutMs);

  // A cancelled host turn must close the microphone now, not when the cap
  // expires. Nothing else would stop the recorder.
  const onAbort = () => child.kill("SIGTERM");
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const code = await child.exited;
    const [stdout, stderr] = await Promise.all([
      collectWithin(outCollector, OUTPUT_GRACE_MS),
      collectWithin(errCollector, OUTPUT_GRACE_MS),
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (hardTimer !== undefined) clearTimeout(hardTimer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface RecordingReport {
  wav_path: string;
  capture_ms: number;
  timed_out: boolean;
  bytes: number;
}

/** Record one reply. Returns as soon as the endpointer hears the human stop. */
export async function recordReply(
  config: ConverseConfig,
  wavPath: string,
  signal?: AbortSignal,
): Promise<RecordingReport> {
  requireBinary(
    config.recBin,
    "no_recorder",
    "Install sox (`brew install sox`), which provides `rec`, or set ECHO_CONVERSE_REC_BIN.",
  );

  const startedAt = Date.now();
  // No SIGKILL escalation here on purpose: the recorder must be allowed to catch
  // the signal and finalize its WAV header, or the capture is unreadable.
  const result = await run([config.recBin, ...recorderArgv(config, wavPath)], {
    timeoutMs: config.maxCaptureMs,
    signal,
  });
  if (existsSync(wavPath)) {
    try {
      chmodSync(wavPath, 0o600);
    } catch {
      // An existing output that cannot be made private must not be returned to a
      // caller. A missing output is handled by the size/readability check below.
      throw new CaptureError("recorder_failed", `${config.recBin} produced audio with unverifiable permissions`);
    }
  }
  throwIfAborted(signal);
  const capture_ms = Date.now() - startedAt;

  let bytes = 0;
  try {
    bytes = statSync(wavPath).size;
  } catch {
    bytes = 0;
  }

  // A recorder killed at the cap still leaves a usable file; a recorder that
  // never produced one failed. Distinguishing them keeps a missing microphone
  // from being reported as silence.
  if (bytes === 0) {
    throw new CaptureError(
      "recorder_failed",
      `${config.recBin} produced no audio (exit ${result.code}): ${result.stderr.trim() || "no error output"}`,
    );
  }
  return { wav_path: wavPath, capture_ms, timed_out: result.timedOut, bytes };
}

/**
 * A stopped transcriber is a failure with a name, never an empty answer: the
 * caller still holds the capture state, and reporting a hang as silence would
 * send the human's spoken reply to `no_speech`.
 */
function requireTranscriberSuccess(
  result: { code: number | null; stderr: string; timedOut: boolean },
  what: string,
  timeoutMs: number,
): void {
  if (result.timedOut) {
    throw new CaptureError("transcriber_failed", `${what} did not finish within ${timeoutMs}ms and was stopped`);
  }
  if (result.code !== 0) {
    throw new CaptureError("transcriber_failed", `${what} exited ${result.code}: ${result.stderr.trim()}`);
  }
}

/**
 * The whole transcription phase shares ONE budget, whatever it takes to reach a
 * transcript. Giving the resample and the transcriber a cap each would let the
 * whisper tier spend two of them, and the turn's lease is calculated from a
 * single transcription cap.
 */
function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

/** Offline rate conversion for whisper, which requires 16kHz mono. */
async function toWhisperInput(
  config: ConverseConfig,
  wavPath: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  // A missing resampler is a transcriber-side failure: the recorder did its job,
  // and reporting it as `no_recorder` would send the operator after sox for the
  // wrong reason.
  requireBinary(
    config.soxBin,
    "transcriber_failed",
    "whisper needs 16kHz mono; install sox (`brew install sox`) or set ECHO_CONVERSE_SOX_BIN.",
  );

  const converted = `${wavPath.replace(/\.wav$/, "")}.16k.wav`;
  let returned = false;
  try {
    const result = await run([config.soxBin, wavPath, "-r", "16000", "-c", "1", "-b", "16", converted], {
      timeoutMs: remainingMs(deadline),
      hardKillAfterMs: HARD_KILL_GRACE_MS,
      signal,
    });
    if (existsSync(converted)) chmodSync(converted, 0o600);
    requireTranscriberSuccess(result, `resampling for whisper (${config.soxBin})`, config.transcribeTimeoutMs);
    returned = true;
    return converted;
  } finally {
    if (!returned) rmSync(converted, { force: true });
  }
}

export async function transcribeFile(
  config: ConverseConfig,
  wavPath: string,
  tier: SttTier,
  signal?: AbortSignal,
): Promise<string> {
  // One deadline for the whole phase. A transcriber has no header to finalize,
  // so its cap escalates to SIGKILL and is therefore hard.
  const deadline = Date.now() + config.transcribeTimeoutMs;

  if (tier === "yap") {
    const result = await run([config.yapBin, "transcribe", "--locale", config.locale, "--txt", wavPath], {
      timeoutMs: remainingMs(deadline),
      hardKillAfterMs: HARD_KILL_GRACE_MS,
      signal,
    });
    throwIfAborted(signal);
    requireTranscriberSuccess(result, config.yapBin, config.transcribeTimeoutMs);
    return result.stdout.trim();
  }

  if (config.whisperModel === undefined) {
    throw new CaptureError("no_stt_tier", "whisper needs ECHO_CONVERSE_WHISPER_MODEL to point at a ggml model file");
  }
  const input = await toWhisperInput(config, wavPath, deadline, signal);
  try {
    const result = await run(
      [
        config.whisperBin,
        "-m", config.whisperModel,
        "-f", input,
        "-l", whisperLanguage(config.locale),
        "-nt",
      ],
      { timeoutMs: remainingMs(deadline), hardKillAfterMs: HARD_KILL_GRACE_MS, signal },
    );
    throwIfAborted(signal);
    requireTranscriberSuccess(result, config.whisperBin, config.transcribeTimeoutMs);
    return result.stdout.trim();
  } finally {
    rmSync(input, { force: true });
  }
}

/**
 * Capture one spoken reply and transcribe it locally.
 *
 * The recording is deleted before this returns, on every path. The transcript is
 * the deliverable; keeping the audio around would leave the human's voice on
 * disk for no reason, and it is never sent to the coordinator either.
 */
export const captureAndTranscribe: CaptureEngine = async (config, signal) => {
  throwIfAborted(signal);
  const tier = selectSttTier(config);
  if (tier === null) {
    throw new CaptureError(
      "no_stt_tier",
      `no local transcriber available: install ${config.yapBin} (macOS 26 Tier 1) or ` +
        `set ECHO_CONVERSE_WHISPER_MODEL for ${config.whisperBin} (Tier 2)`,
    );
  }

  mkdirSync(config.captureDir, { recursive: true, mode: 0o700 });
  chmodSync(config.captureDir, 0o700);
  const wavPath = join(config.captureDir, `reply-${Date.now()}-${process.pid}.wav`);

  try {
    const recording = await recordReply(config, wavPath, signal);
    throwIfAborted(signal);
    const text = recording.bytes < MIN_AUDIBLE_WAV_BYTES ? "" : await transcribeFile(config, wavPath, tier, signal);
    throwIfAborted(signal);
    if (text.length === 0) {
      throw new CaptureError("no_speech", "the recording contained no speech");
    }
    return { text, engine: tier, capture_ms: recording.capture_ms, timed_out: recording.timed_out };
  } finally {
    rmSync(wavPath, { force: true });
  }
};
