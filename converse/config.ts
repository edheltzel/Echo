// Configuration for the echo-converse capability.
//
// Resolution goes through @echo/shared's read-only resolver: live process values
// win, then ~/.config/echo/config.json, then a legacy dotenv file. Nothing here
// writes process.env - converse is loaded inside long-lived host processes (a Pi
// extension, an MCP server), where hydrating the environment would leak the
// operator's identity into whatever else that process runs.

import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDaemonBase } from "@echo/shared/daemon-endpoints.ts";
import { loadEchoConfiguration, type EchoEnvironment } from "@echo/shared/echo-env.ts";

/** Keypad ECHOV. Core's TTS daemon keeps :3246; converse never moves it. */
export const DEFAULT_CONVERSE_PORT = 32468;

/** Slack over the bounded capture and transcription work for one booking. */
export const CONVERSE_LEASE_SLACK_MS = 30_000;

/** Speech-to-text rungs, local-only by design (no cloud rung in v1). */
export type SttTier = "yap" | "whisper";

export interface ConverseConfig {
  /** Port the coordinator listens on. */
  port: number;
  /** Origin host adapters address the coordinator through. */
  baseUrl: string;
  /**
   * Core's `/notify` + `/health` origin: the daemon converse speaks through.
   * Resolved by `shared/daemon-endpoints.ts`, the one module that knows the
   * daemon's address, so an operator who configured only `ECHO_NOTIFY_URL`
   * reaches the same instance their notifications already reach.
   */
  coreBaseUrl: string;
  /** Single-microphone booking lock (atomic create, stale owner reaped). */
  bookingLockPath: string;
  /** How long a booking may be held before it is reapable as abandoned. */
  leaseMs: number;
  /** Directory for capture WAVs. User-owned; never /tmp. */
  captureDir: string;
  /** Hard cap on one capture, whatever the endpointer does. */
  maxCaptureMs: number;
  /**
   * Hard cap on the transcription step, for the same reason the recorder has
   * one: the capture state stays non-idle for the whole turn, and core skips
   * every voice line while it is. A wedged transcriber would otherwise mute the
   * operator's Echo for as long as the calling host lives.
   */
  transcribeTimeoutMs: number;
  /** Trailing silence that ends a capture. */
  silenceMs: number;
  /** BCP-47 locale for the transcriber. */
  locale: string;
  /** `undefined` selects the best available rung at capture time. */
  sttTier: SttTier | undefined;
  recBin: string;
  /** Offline rate conversion for the whisper rung; `rec` is sox in record mode. */
  soxBin: string;
  yapBin: string;
  whisperBin: string;
  /** whisper.cpp needs a model file; there is no bundled default. */
  whisperModel: string | undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

function parseTier(raw: string | undefined): SttTier | undefined {
  return raw === "yap" || raw === "whisper" ? raw : undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * State lives under `~/.local/state/echo/converse/`, matching the capture-state
 * contract's own `~/.local/state` convention rather than XDG.
 */
export function converseStateDir(homeDir: string = homedir()): string {
  return join(homeDir, ".local", "state", "echo", "converse");
}

export function resolveConverseConfig(
  env: EchoEnvironment = loadEchoConfiguration(),
  homeDir: string = homedir(),
): ConverseConfig {
  const port = positiveInt(env.ECHO_CONVERSE_PORT, DEFAULT_CONVERSE_PORT);
  return {
    port,
    baseUrl: stripTrailingSlash(env.ECHO_CONVERSE_URL || `http://localhost:${port}`),
    coreBaseUrl: resolveDaemonBase(env),
    bookingLockPath: env.ECHO_CONVERSE_BOOKING_LOCK || join(converseStateDir(homeDir), "booking.lock"),
    leaseMs: positiveInt(env.ECHO_CONVERSE_LEASE_MS, 120_000),
    captureDir: env.ECHO_CONVERSE_CAPTURE_DIR || join(homeDir, "Library", "Caches", "echo", "converse"),
    maxCaptureMs: positiveInt(env.ECHO_CONVERSE_MAX_CAPTURE_MS, 30_000),
    transcribeTimeoutMs: positiveInt(env.ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS, 60_000),
    silenceMs: positiveInt(env.ECHO_CONVERSE_SILENCE_MS, 1_500),
    locale: env.ECHO_CONVERSE_LOCALE || "en-US",
    sttTier: parseTier(env.ECHO_CONVERSE_STT_TIER),
    recBin: env.ECHO_CONVERSE_REC_BIN || "rec",
    soxBin: env.ECHO_CONVERSE_SOX_BIN || "sox",
    yapBin: env.ECHO_CONVERSE_YAP_BIN || "yap",
    whisperBin: env.ECHO_CONVERSE_WHISPER_BIN || "whisper-cli",
    whisperModel: nonEmpty(env.ECHO_CONVERSE_WHISPER_MODEL),
  };
}
