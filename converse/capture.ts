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

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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
export type CaptureEngine = (config: ConverseConfig) => Promise<CaptureEngineResult>;

export class CaptureError extends Error {
  constructor(readonly code: "no_stt_tier" | "recorder_failed" | "transcriber_failed" | "no_speech", message: string) {
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

/**
 * Read a finished child's pipe without being able to hang on it.
 *
 * Waiting for end-of-stream is not safe here: a killed recorder can leave a
 * grandchild holding the same pipe open, and the read would then outlive the
 * process it was reading. The output is already buffered by the time the child
 * exits in every normal case, so a short grace period costs nothing and removes
 * the hang.
 */
async function readWithin(stream: ReadableStream<Uint8Array>, graceMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      void stream.cancel().catch(() => {});
      resolve("");
    }, graceMs);
  });
  try {
    return await Promise.race([new Response(stream).text().catch(() => ""), grace]);
  } finally {
    clearTimeout(timer);
  }
}

const OUTPUT_GRACE_MS = 500;

async function run(cmd: string[], timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        // SIGTERM, not SIGKILL: sox finalizes the WAV header on a caught signal,
        // and a truncated header is an unreadable recording. Verified on macOS
        // 26.5.2 - a recorder stopped at the cap still yields a readable file.
        child.kill("SIGTERM");
      }, timeoutMs);

  try {
    const code = await child.exited;
    const [stdout, stderr] = await Promise.all([
      readWithin(child.stdout, OUTPUT_GRACE_MS),
      readWithin(child.stderr, OUTPUT_GRACE_MS),
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RecordingReport {
  wav_path: string;
  capture_ms: number;
  timed_out: boolean;
  bytes: number;
}

/** Record one reply. Returns as soon as the endpointer hears the human stop. */
export async function recordReply(config: ConverseConfig, wavPath: string): Promise<RecordingReport> {
  const startedAt = Date.now();
  const result = await run([config.recBin, ...recorderArgv(config, wavPath)], config.maxCaptureMs);
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

/** Offline rate conversion for whisper, which requires 16kHz mono. */
async function toWhisperInput(config: ConverseConfig, wavPath: string): Promise<string> {
  const converted = `${wavPath.replace(/\.wav$/, "")}.16k.wav`;
  const result = await run([config.soxBin, wavPath, "-r", "16000", "-c", "1", "-b", "16", converted]);
  if (result.code !== 0) {
    throw new CaptureError("transcriber_failed", `resampling for whisper failed: ${result.stderr.trim()}`);
  }
  return converted;
}

export async function transcribeFile(config: ConverseConfig, wavPath: string, tier: SttTier): Promise<string> {
  if (tier === "yap") {
    const result = await run([config.yapBin, "transcribe", "--locale", config.locale, "--txt", wavPath]);
    if (result.code !== 0) {
      throw new CaptureError("transcriber_failed", `${config.yapBin} exited ${result.code}: ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }

  if (config.whisperModel === undefined) {
    throw new CaptureError("no_stt_tier", "whisper needs ECHO_CONVERSE_WHISPER_MODEL to point at a ggml model file");
  }
  const input = await toWhisperInput(config, wavPath);
  try {
    const result = await run([
      config.whisperBin,
      "-m", config.whisperModel,
      "-f", input,
      "-l", whisperLanguage(config.locale),
      "-nt",
    ]);
    if (result.code !== 0) {
      throw new CaptureError("transcriber_failed", `${config.whisperBin} exited ${result.code}: ${result.stderr.trim()}`);
    }
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
export const captureAndTranscribe: CaptureEngine = async (config) => {
  const tier = selectSttTier(config);
  if (tier === null) {
    throw new CaptureError(
      "no_stt_tier",
      `no local transcriber available: install ${config.yapBin} (macOS 26 Tier 1) or ` +
        `set ECHO_CONVERSE_WHISPER_MODEL for ${config.whisperBin} (Tier 2)`,
    );
  }

  mkdirSync(config.captureDir, { recursive: true, mode: 0o700 });
  const wavPath = join(config.captureDir, `reply-${Date.now()}-${process.pid}.wav`);

  try {
    const recording = await recordReply(config, wavPath);
    const text = recording.bytes < MIN_AUDIBLE_WAV_BYTES ? "" : await transcribeFile(config, wavPath, tier);
    if (text.length === 0) {
      throw new CaptureError("no_speech", "the recording contained no speech");
    }
    return { text, engine: tier, capture_ms: recording.capture_ms, timed_out: recording.timed_out };
  } finally {
    rmSync(wavPath, { force: true });
  }
};
