#!/usr/bin/env bun
/**
 * Voice Server - Multi-Provider TTS Notification Server
 *
 * Supports three TTS providers (configurable in voices.json):
 * 1. Kokoro (local) - Free, offline, no API key needed
 * 2. ElevenLabs (cloud) - Premium quality, requires API key
 * 3. macOS say (system) - Basic quality, always available fallback
 *
 * Features:
 * - Provider abstraction layer for extensibility
 * - Per-provider circuit breakers (fast fallback after failures)
 * - Configurable fallback chain
 * - Environment variable support for API keys
 * - Consolidated config in voices.json
 * - Pronunciation preprocessing (pronunciations.json)
 * - 13 Emotional presets via emoji markers ([💡 insight], [🎉 celebration], etc.)
 * - Pass-through voice_settings from callers (tier-1 override)
 */

import { serve } from "bun";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { edgeRateFromSpeed } from "./edge-rate";
import { parseBoundedInt, resolveEchoEnv } from "./env";
import { readMuteState, setMuteState, toggleMuteState } from "./mute";
import { isCaptureActive, readCaptureState, resolveCaptureStatePath } from "./capture-guard";
import { PlayQueue } from "./play-queue";
import { readTtsCache, writeTtsCache } from "./tts-cache";
import { looksLikeEdgeVoice } from "../shared/edge-voice";
import {
  writeAudioLifecycleEvent,
  classifyPlaybackOutcome,
  classifyPlaybackError,
  parseAfinfoDuration,
  type AudioLifecycleEvent,
  type PlaybackExitReason,
} from "./audio-log";
import {
  CIRCUIT_BREAKER_RESET_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  circuitBreakers,
  recordProviderFailure,
  recordProviderSuccess,
  setCircuitBreakerLogger,
  shouldSkipProvider,
} from "./circuit-breaker";

// =============================================================================
// Types and Interfaces
// =============================================================================

interface TTSProvider {
  name: string;
  isEnabled(): boolean;
  isHealthy(): Promise<boolean>;
  speak(text: string, voice?: string, settings?: VoiceSettings): Promise<boolean>;
  getLastDiagnostic?(): ProviderDiagnostic | undefined;
}

interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

interface ProviderDiagnostic {
  phase?: string;
  reason?: string;
  message?: string;
  elapsed_ms?: number;
  timeout_ms?: number;
  exit_code?: number | null;
  signal?: string | null;
  stderr?: string;
  command?: string;
}

interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  endpoint?: string;
  defaultVoice?: string;
  defaultVoiceId?: string;
  voice?: string;
  rate?: string;
  description?: string;
}

interface VoiceMapping {
  description?: string;
  catchphrase?: string;
  elevenlabs?: {
    voice_id: string;
    voice_name?: string;
    stability?: number;
    similarity_boost?: number;
    style?: number;
    use_speaker_boost?: boolean;
  };
  kokoro?: {
    voice: string;
    speed?: number;
  };
  edgetts?: {
    voice: string;
    speed?: number;
  };
}

interface VoicesConfig {
  providers: {
    edgetts: ProviderConfig;
    kokoro: ProviderConfig;
    elevenlabs: ProviderConfig;
    say: ProviderConfig;
  };
  defaultProvider: string;
  fallbackOrder: string[];
  default_rate?: number;
  default_volume?: number;
  identity: VoiceMapping;
  agents: Record<string, VoiceMapping>;
}

// =============================================================================
// Structured Logging
// =============================================================================

// Host adapters should include their local session identifier in the POST body
// as `session_id` and identify themselves with `source`. The log format below
// is intentionally host-neutral and ready for any adapter/client.

let requestCounter = 0;

function logTimestamp(): string {
  return new Date().toISOString();
}

function generateRequestId(): string {
  return `req-${++requestCounter}-${Date.now().toString(36)}`;
}

interface LogContext {
  requestId?: string;
  sessionId?: string;
  source?: string;
}

function log(level: 'info' | 'warn' | 'error', message: string, ctx?: LogContext): void {
  const ts = logTimestamp();
  const prefix = ctx?.requestId ? `[${ctx.requestId}]` : '';
  const session = ctx?.sessionId ? ` session=${ctx.sessionId}` : '';
  const source = ctx?.source ? ` source=${ctx.source}` : '';
  const meta = `${prefix}${session}${source}`;
  const line = `${ts} ${level.toUpperCase()} ${meta ? meta + ' ' : ''}${message}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// =============================================================================
// Configuration Loading
// =============================================================================

// Env-file config (first found wins per key; a real process value always
// beats every file) is resolved through resolveEchoEnv (core/env.ts), which
// NEVER writes to process.env — importing this module must not leak the
// operator's env-file identity (ECHO_VOICE_*) into same-process adapter code
// or its tests (the pi-adapter "Atlas" pollution; AGENTS.md #47 class hazard).

const PORT = parseInt(resolveEchoEnv("PORT") || "8888");
const VOICES_PATH = resolveEchoEnv("VOICES_PATH") || join(import.meta.dir, 'voices.json');
const DEFAULT_MACOS_VOICE = 'Daniel (Enhanced)';
const ELEVENLABS_TIMEOUT_MS = 10_000;
const KOKORO_TIMEOUT_MS = 10_000;
const DEFAULT_NOTIFICATION_TITLE = resolveEchoEnv("ECHO_DEFAULT_TITLE") ?? resolveEchoEnv("VOICESYSTEM_DEFAULT_TITLE") ?? "Voice Notification";
const AUDIO_PROCESS_TIMEOUT_MS = parseInt(resolveEchoEnv("ECHO_AUDIO_PROCESS_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_AUDIO_PROCESS_TIMEOUT_MS") ?? "60000");
const NOTIFICATION_PROCESS_TIMEOUT_MS = parseInt(resolveEchoEnv("ECHO_NOTIFICATION_PROCESS_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_NOTIFICATION_PROCESS_TIMEOUT_MS") ?? "10000");
const AUDIO_CACHE_DIR = resolveEchoEnv("ECHO_AUDIO_CACHE_DIR") ?? resolveEchoEnv("VOICESYSTEM_AUDIO_CACHE_DIR") ?? (
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Caches', 'echo', 'audio')
    : join(resolveEchoEnv("XDG_CACHE_HOME") || join(homedir(), '.cache'), 'echo', 'audio')
);

// Resolve environment variables in config values
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.match(/^\$\{([^}]+)\}$/);
  if (match) {
    return resolveEchoEnv(match[1]);
  }
  return value;
}

// Load voices.json (single source of truth for all voice config)
function loadVoicesConfig(): VoicesConfig {
  const defaultConfig: VoicesConfig = {
    providers: {
      edgetts: {
        enabled: true,
        defaultVoice: 'en-US-AvaNeural',
        description: 'Microsoft Edge TTS - free, high-quality neural voices'
      },
      kokoro: {
        enabled: true,
        endpoint: 'http://127.0.0.1:8880/v1',
        defaultVoice: 'af_sky',
        description: 'Local TTS - free, offline, no API key needed'
      },
      elevenlabs: {
        enabled: false,
        apiKey: '${ELEVENLABS_API_KEY}',
        defaultVoiceId: 's3TPKV1kjDlVtZbl4Ksh',
        description: 'Premium cloud TTS - requires API key from elevenlabs.io'
      },
      say: {
        enabled: true,
        voice: DEFAULT_MACOS_VOICE,
        description: 'macOS built-in - always available fallback'
      }
    },
    defaultProvider: 'edgetts',
    fallbackOrder: ['edgetts', 'elevenlabs', 'kokoro', 'say'],
    default_volume: 0.8,
    identity: {
      description: 'Main AI assistant voice',
      kokoro: { voice: 'am_adam', speed: 1.1 }
    },
    agents: {}
  };

  try {
    if (existsSync(VOICES_PATH)) {
      const content = readFileSync(VOICES_PATH, 'utf-8');
      const config = JSON.parse(content);
      console.log('✅ Loaded voice config from voices.json');
      return {
        ...defaultConfig,
        ...config,
        providers: {
          ...defaultConfig.providers,
          ...config.providers
        }
      };
    }
  } catch (error) {
    console.warn('⚠️  Failed to load voices.json, using defaults');
  }

  return defaultConfig;
}

// Global config (loaded once at startup)
export const voicesConfig = loadVoicesConfig();

function getMacOSFallbackVoice(): string {
  return voicesConfig.providers.say.voice || DEFAULT_MACOS_VOICE;
}

// =============================================================================
// Pronunciation System (from v3.0)
// =============================================================================

interface PronunciationEntry {
  term: string;
  phonetic: string;
  note?: string;
}

interface PronunciationConfig {
  replacements: PronunciationEntry[];
}

interface CompiledRule {
  regex: RegExp;
  phonetic: string;
}

let pronunciationRules: CompiledRule[] = [];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPronunciations(): void {
  const pronPath = resolveEchoEnv("PRONUNCIATIONS_PATH") || join(import.meta.dir, 'pronunciations.json');
  try {
    if (!existsSync(pronPath)) {
      console.warn('⚠️  No pronunciations.json found — TTS will use default pronunciations');
      return;
    }
    const content = readFileSync(pronPath, 'utf-8');
    const config: PronunciationConfig = JSON.parse(content);

    pronunciationRules = config.replacements.map(entry => ({
      regex: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'g'),
      phonetic: entry.phonetic,
    }));

    console.log(`📖 Loaded ${pronunciationRules.length} pronunciation rules`);
    for (const entry of config.replacements) {
      console.log(`   ${entry.term} → ${entry.phonetic}${entry.note ? ` (${entry.note})` : ''}`);
    }
  } catch (error) {
    console.error('⚠️  Failed to load pronunciations.json:', error);
  }
}

function applyPronunciations(text: string): string {
  let result = text;
  for (const rule of pronunciationRules) {
    result = result.replace(rule.regex, rule.phonetic);
  }
  return result;
}

// Load pronunciations at startup
loadPronunciations();

// =============================================================================
// Emotional Presets (from v3.0) — overlays stability + similarity_boost
// =============================================================================

interface EmotionalOverlay {
  stability: number;
  similarity_boost: number;
}

const EMOTIONAL_PRESETS: Record<string, EmotionalOverlay> = {
  // High Energy / Positive
  'excited':      { stability: 0.70, similarity_boost: 0.90 },
  'celebration':  { stability: 0.65, similarity_boost: 0.85 },
  'insight':      { stability: 0.55, similarity_boost: 0.80 },
  'creative':     { stability: 0.50, similarity_boost: 0.75 },

  // Success / Achievement
  'success':      { stability: 0.60, similarity_boost: 0.80 },
  'progress':     { stability: 0.55, similarity_boost: 0.75 },

  // Analysis / Investigation
  'investigating':{ stability: 0.60, similarity_boost: 0.85 },
  'debugging':    { stability: 0.55, similarity_boost: 0.80 },
  'learning':     { stability: 0.50, similarity_boost: 0.75 },

  // Thoughtful / Careful
  'pondering':    { stability: 0.65, similarity_boost: 0.80 },
  'focused':      { stability: 0.70, similarity_boost: 0.85 },
  'caution':      { stability: 0.40, similarity_boost: 0.60 },

  // Urgent / Critical
  'urgent':       { stability: 0.30, similarity_boost: 0.90 },
};

const EMOJI_TO_EMOTION: Record<string, string> = {
  '\u{1F4A5}': 'excited',
  '\u{1F389}': 'celebration',
  '\u{1F4A1}': 'insight',
  '\u{1F3A8}': 'creative',
  '\u{2728}':  'success',
  '\u{1F4C8}': 'progress',
  '\u{1F50D}': 'investigating',
  '\u{1F41B}': 'debugging',
  '\u{1F4DA}': 'learning',
  '\u{1F914}': 'pondering',
  '\u{1F3AF}': 'focused',
  '\u{26A0}\u{FE0F}': 'caution',
  '\u{1F6A8}': 'urgent',
};

function extractEmotionalMarker(message: string): { cleaned: string; emotion?: string } {
  const emotionMatch = message.match(/\[(\u{1F4A5}|\u{1F389}|\u{1F4A1}|\u{1F3A8}|\u{2728}|\u{1F4C8}|\u{1F50D}|\u{1F41B}|\u{1F4DA}|\u{1F914}|\u{1F3AF}|\u{26A0}\u{FE0F}|\u{1F6A8})\s+(\w+)\]/u);
  if (emotionMatch) {
    const emoji = emotionMatch[1];
    const emotionName = emotionMatch[2].toLowerCase();
    if (EMOJI_TO_EMOTION[emoji] === emotionName) {
      return {
        cleaned: message.replace(emotionMatch[0], '').trim(),
        emotion: emotionName,
      };
    }
  }
  return { cleaned: message };
}

// =============================================================================
// Circuit Breakers - Per-Provider Fast Fallback
// =============================================================================
// Breaker state + record/skip logic lives in ./circuit-breaker (host-neutral,
// unit-tested). Wire it to the server's structured logger here.

setCircuitBreakerLogger((level, message) => log(level, message));

// =============================================================================
// Voice Configuration Lookup
// =============================================================================

export function getVoiceMapping(identifier: string | null): VoiceMapping | null {
  if (!identifier) {
    return voicesConfig.identity;
  }

  // Check agents by name
  if (voicesConfig.agents[identifier]) {
    return voicesConfig.agents[identifier];
  }

  // Check by ElevenLabs voice ID
  for (const [, mapping] of Object.entries(voicesConfig.agents)) {
    if (mapping.elevenlabs?.voice_id === identifier) {
      return mapping;
    }
  }

  // Check identity
  if (voicesConfig.identity.elevenlabs?.voice_id === identifier) {
    return voicesConfig.identity;
  }

  return null;
}

// The edge-tts voice-name grammar is owned by `shared/edge-voice.ts` — the daemon and
// the adapters' `/echo-voice` scaffold both enforce it, so it is defined once there and
// re-exported here for existing callers.
export { looksLikeEdgeVoice };

// =============================================================================
// Utility Functions
// =============================================================================

function escapeForAppleScript(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\t]/g, ' ');  // patched 2026-05-15 (RedTeam PT-1): collapse line breaks/tabs so they can't break out of the AppleScript string literal
}

function stripMarkers(message: string): string {
  return message.replace(/\[[^\]]*\]/g, '').trim();
}

function sanitizeForSpeech(input: string): string {
  const cleaned = input
    .replace(/<script/gi, '')
    .replace(/\.\.\//g, '')
    .replace(/[;&|><`$\\]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .trim()
    .substring(0, 500);

  return cleaned;
}

function validateInput(input: any): { valid: boolean; error?: string; sanitized?: string } {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'Invalid input type' };
  }

  if (input.length > 500) {
    return { valid: false, error: 'Message too long (max 500 characters)' };
  }

  const sanitized = sanitizeForSpeech(input);

  if (!sanitized || sanitized.length === 0) {
    return { valid: false, error: 'Message contains no valid content after sanitization' };
  }

  return { valid: true, sanitized };
}

function getVolumeSetting(): number {
  const vol = voicesConfig.default_volume;
  if (typeof vol === 'number' && vol >= 0 && vol <= 1) {
    return vol;
  }
  return 1.0;
}

function createAudioTempFile(prefix: string, extension: string): { dir: string; file: string } {
  mkdirSync(AUDIO_CACHE_DIR, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(AUDIO_CACHE_DIR, `${prefix}-`));
  return { dir, file: join(dir, `audio.${extension}`) };
}

function cleanupAudioTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only; playback/synthesis failures are reported elsewhere.
  }
}

function waitForProcess(proc: ReturnType<typeof spawn>, label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };

    const timeout = setTimeout(() => {
      proc.kill();
      finish(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', (error) => finish(error));
    proc.on('exit', (code) => {
      if (code === 0) finish();
      else finish(new Error(`${label} exited with code ${code}`));
    });
  });
}

// --- Audio lifecycle capture (Phase 1 / U2) --------------------------------
// A per-request mutable slot carried via AsyncLocalStorage so the two playback
// sites (playAudio + the inline edgetts path) can deposit measured metrics
// without threading params through every provider signature. ALS keeps
// concurrent /notify requests isolated. The /notify handler owns run() and the
// final writeAudioLifecycleEvent; playback sites only deposit here.
interface AudioCaptureSlot {
  synth_duration_ms?: number | null;
  clip_duration_s?: number | null;
  play_started_at?: string | null;
  play_ended_at?: string | null;
  play_time_ms?: number | null;
  exit_reason?: PlaybackExitReason | null;
}

const audioCapture = new AsyncLocalStorage<AudioCaptureSlot>();

// Best-effort clip duration via afinfo (present on macOS). Never throws.
function afinfoDurationSafe(file: string): number | null {
  try {
    const res = Bun.spawnSync(['/usr/bin/afinfo', file]);
    return parseAfinfoDuration(res.stdout.toString());
  } catch {
    return null;
  }
}

// Deposit playback metrics into the ambient request slot. No-op outside a
// request (e.g. a unit test calling playAudio directly) so instrumentation
// never depends on the caller. `error` present → derive the exit reason from
// the waitForProcess rejection; absent → a clean exit.
function recordPlayback(file: string, playStart: number, playEnd: number, outcome: { exitCode: number | null; error?: unknown }): void {
  const slot = audioCapture.getStore();
  if (!slot) return;
  const reason: PlaybackExitReason = 'error' in outcome
    ? classifyPlaybackOutcome(classifyPlaybackError(outcome.error instanceof Error ? outcome.error.message : String(outcome.error)))
    : classifyPlaybackOutcome({ timedOut: false, errored: false, exitCode: outcome.exitCode ?? 0 });
  slot.clip_duration_s = afinfoDurationSafe(file);
  slot.play_started_at = new Date(playStart).toISOString();
  slot.play_ended_at = new Date(playEnd).toISOString();
  slot.play_time_ms = playEnd - playStart;
  slot.exit_reason = reason;
}

async function playAudio(audioBuffer: ArrayBuffer, format: 'mp3' | 'wav' | 'aiff' = 'mp3'): Promise<void> {
  const temp = createAudioTempFile('play', format);
  await Bun.write(temp.file, audioBuffer);

  const volume = getVolumeSetting();
  const proc = spawn('/usr/bin/afplay', ['-v', volume.toString(), temp.file]);

  const playStart = Date.now();
  try {
    await waitForProcess(proc, 'afplay', AUDIO_PROCESS_TIMEOUT_MS);
    recordPlayback(temp.file, playStart, Date.now(), { exitCode: 0 });
  } catch (error) {
    recordPlayback(temp.file, playStart, Date.now(), { exitCode: null, error });
    throw error;
  } finally {
    cleanupAudioTempDir(temp.dir);
  }
}

function spawnSafe(command: string, args: string[], timeoutMs = NOTIFICATION_PROCESS_TIMEOUT_MS): Promise<void> {
  const proc = spawn(command, args);
  return waitForProcess(proc, command, timeoutMs);
}

// =============================================================================
// TTS Provider Implementations
// =============================================================================

// --- Edge TTS Provider ---
// edge-tts is Microsoft's ONLINE WebSocket TTS, so transient synthesis blips
// happen. Retry the synth step a bounded number of times before counting a
// provider failure. Health checks are diagnostic only on the hot /notify path:
// an import probe must not veto a real synthesis attempt unless the breaker is
// already open from genuine provider failures.
// Bounded parses: a NaN/negative/zero override must fall back to the default,
// never to a degenerate value (0ms timeout = instant fail; 0 retries from NaN
// would zero the loop → false success). retries floor 0, timeout/backoff floor 1.
// Canonical ECHO_* read first; legacy VOICESYSTEM_* kept as a silent fallback.
const EDGETTS_TIMEOUT_MS = parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_TIMEOUT_MS"), 15000, 1);
const EDGETTS_TIMEOUT_MAX_MS = parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_MAX_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_TIMEOUT_MAX_MS"), 60000, 1);
const EDGETTS_TIMEOUT_PER_CHAR_MS = parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_PER_CHAR_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_TIMEOUT_PER_CHAR_MS"), 20, 0);
const EDGETTS_HEALTH_TIMEOUT_MS = parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_HEALTH_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_HEALTH_TIMEOUT_MS"), 3000, 1);
const EDGETTS_SYNTH_RETRIES = parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_SYNTH_RETRIES") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_SYNTH_RETRIES"), 1, 0);
const EDGETTS_SYNTH_BACKOFF_MS = parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_SYNTH_BACKOFF_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_SYNTH_BACKOFF_MS"), 250, 1);
const PYTHON3_PATH = '/opt/homebrew/bin/python3';

class EdgeProcessError extends Error {
  diagnostic: ProviderDiagnostic;

  constructor(diagnostic: ProviderDiagnostic) {
    super(diagnostic.message || diagnostic.reason || 'Edge TTS process failed');
    this.name = 'EdgeProcessError';
    this.diagnostic = diagnostic;
  }
}

let edgeSynthesisQueue: Promise<void> = Promise.resolve();

async function serializeEdgeSynthesis<T>(fn: () => Promise<T>): Promise<T> {
  const previous = edgeSynthesisQueue.catch(() => {});
  let release!: () => void;
  edgeSynthesisQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function trimDiagnosticText(value: unknown, maxLength = 500): string | undefined {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function edgeCommandLabel(phase: string): string {
  return phase === 'health-import'
    ? `${PYTHON3_PATH} -c "import edge_tts"`
    : `${PYTHON3_PATH} -m edge_tts`;
}

function formatProviderDiagnostic(diagnostic: ProviderDiagnostic): string {
  const parts = [
    diagnostic.reason || 'error',
    diagnostic.phase && `phase=${diagnostic.phase}`,
    diagnostic.elapsed_ms !== undefined && `elapsed=${diagnostic.elapsed_ms}ms`,
    diagnostic.timeout_ms !== undefined && `timeout=${diagnostic.timeout_ms}ms`,
    diagnostic.exit_code !== undefined && `exit=${diagnostic.exit_code}`,
    diagnostic.signal && `signal=${diagnostic.signal}`,
    diagnostic.command && `cmd=${diagnostic.command}`,
    diagnostic.stderr && `stderr=${JSON.stringify(diagnostic.stderr)}`,
  ].filter(Boolean);
  return parts.join(' ');
}

function diagnosticFromError(error: unknown): ProviderDiagnostic {
  if (error instanceof EdgeProcessError) return error.diagnostic;
  const message = error instanceof Error ? error.message : String(error);
  return { reason: 'error', message };
}

function edgeSynthesisTimeoutMs(text: string): number {
  return Math.min(EDGETTS_TIMEOUT_MAX_MS, EDGETTS_TIMEOUT_MS + text.length * EDGETTS_TIMEOUT_PER_CHAR_MS);
}

function runEdgeProcess(
  args: string[],
  phase: string,
  timeoutMs: number,
): Promise<ProviderDiagnostic> {
  const startedAt = Date.now();
  const child = spawn(PYTHON3_PATH, args);
  let stderr = '';

  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  return new Promise<ProviderDiagnostic>((resolve, reject) => {
    let settled = false;
    const command = edgeCommandLabel(phase);
    const finish = (diagnostic: ProviderDiagnostic, failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const fullDiagnostic: ProviderDiagnostic = {
        phase,
        elapsed_ms: Date.now() - startedAt,
        timeout_ms: timeoutMs,
        command,
        ...diagnostic,
        ...(trimDiagnosticText(stderr) && { stderr: trimDiagnosticText(stderr) }),
      };
      if (failed) reject(new EdgeProcessError(fullDiagnostic));
      else resolve(fullDiagnostic);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish({ reason: 'timeout', message: `${phase} timed out after ${timeoutMs}ms` }, true);
    }, timeoutMs);

    child.on('error', (error) => {
      finish({ reason: 'spawn-error', message: error.message }, true);
    });
    child.on('exit', (code, signal) => {
      if ((code ?? 1) === 0) {
        finish({ reason: 'ok', exit_code: code, signal: signal ? String(signal) : null }, false);
      } else {
        finish({ reason: 'nonzero-exit', message: `${phase} exited with code ${code}`, exit_code: code, signal: signal ? String(signal) : null }, true);
      }
    });
  });
}

class EdgeTTSProvider implements TTSProvider {
  name = 'edgetts';
  private lastDiagnostic: ProviderDiagnostic | undefined;

  isEnabled(): boolean {
    return voicesConfig.providers.edgetts?.enabled !== false;
  }

  getLastDiagnostic(): ProviderDiagnostic | undefined {
    return this.lastDiagnostic;
  }

  async isHealthy(): Promise<boolean> {
    if (shouldSkipProvider('edgetts')) {
      this.lastDiagnostic = { phase: 'circuit-breaker', reason: 'circuit-open', message: 'edge-tts circuit breaker is open' };
      return false;
    }
    // Check module importability only — no network call. This is diagnostic for
    // /health/startup output; /notify tries synthesis directly unless the breaker
    // is open so a slow import probe cannot force a false fallback to `say`.
    try {
      await runEdgeProcess(['-c', 'import edge_tts'], 'health-import', EDGETTS_HEALTH_TIMEOUT_MS);
      return true;
    } catch (error) {
      this.lastDiagnostic = diagnosticFromError(error);
      console.warn(`⚕️  Edge TTS health probe failed: ${formatProviderDiagnostic(this.lastDiagnostic)}`);
      return false;
    }
  }

  // Synthesize one attempt to outFile. Resolves on success, rejects on a
  // non-zero exit, spawn error, or timeout — i.e. a genuine PROVIDER failure.
  private synthesizeOnce(processedText: string, voice: string, rate: string, outFile: string, timeoutMs: number): Promise<ProviderDiagnostic> {
    return runEdgeProcess([
      '-m', 'edge_tts',
      '--text', processedText,
      '--voice', voice,
      '--rate', rate,
      '--write-media', outFile,
    ], 'synthesis', timeoutMs);
  }

  async speak(text: string, voice?: string, settings?: VoiceSettings): Promise<boolean> {
    const edgettsVoice = voice || voicesConfig.providers.edgetts?.defaultVoice || 'en-US-AvaNeural';
    const rate = edgeRateFromSpeed(settings?.speed, voicesConfig.providers.edgetts?.rate);
    const processedText = applyPronunciations(text);
    const synthTimeoutMs = edgeSynthesisTimeoutMs(processedText);
    let tmp: { dir: string; file: string } | undefined;
    this.lastDiagnostic = undefined;

    // --- Cache fast-path -----------------------------------------------------
    // A short, repeated phrase (the startup catchphrase, "standing by", …) is
    // played straight from disk, skipping the edge-tts network synthesis that
    // dominates startup latency (#202). On a local playback failure we fall
    // through to a fresh synthesis below rather than staying silent.
    const cachedFile = readTtsCache(edgettsVoice, rate, processedText);
    if (cachedFile) {
      const player = process.platform === 'darwin' ? '/usr/bin/afplay' : 'mpv';
      const playStart = Date.now();
      try {
        console.log(`⚡ Edge TTS cache hit (voice: ${edgettsVoice}, rate: ${rate}) — playing from disk`);
        const play = spawn(player, [cachedFile]);
        await waitForProcess(play, player, AUDIO_PROCESS_TIMEOUT_MS);
        recordPlayback(cachedFile, playStart, Date.now(), { exitCode: 0 });
        const slot = audioCapture.getStore();
        if (slot) slot.synth_duration_ms = 0; // cache hit → no synthesis
        recordProviderSuccess('edgetts');
        this.lastDiagnostic = undefined;
        console.log('✅ Edge TTS completed (cache)');
        return true;
      } catch (cachePlayError: any) {
        recordPlayback(cachedFile, playStart, Date.now(), { exitCode: null, error: cachePlayError });
        console.warn(`🔇 Edge TTS cache-hit playback failed via ${player}; re-synthesizing:`, cachePlayError.message || cachePlayError);
      }
    }

    try {
      // --- Synthesis (the provider's responsibility → governed by the breaker).
      //     Retry transient blips with backoff before recording a failure. ---
      let synthDiagnostic: ProviderDiagnostic | undefined;
      const synthStart = Date.now();
      for (let attempt = 0; attempt <= EDGETTS_SYNTH_RETRIES; attempt++) {
        if (attempt > 0) {
          console.warn(`🔁 Edge TTS synth retry ${attempt}/${EDGETTS_SYNTH_RETRIES}...`);
          await Bun.sleep(EDGETTS_SYNTH_BACKOFF_MS * attempt);
        }
        if (tmp) cleanupAudioTempDir(tmp.dir);
        tmp = createAudioTempFile('edgetts', 'mp3');
        console.log(`🌐 Edge TTS speaking (voice: ${edgettsVoice}, rate: ${rate}, timeout: ${synthTimeoutMs}ms)...`);
        try {
          await serializeEdgeSynthesis(() => this.synthesizeOnce(processedText, edgettsVoice, rate, tmp!.file, synthTimeoutMs));
          synthDiagnostic = undefined;
          break;
        } catch (err) {
          synthDiagnostic = diagnosticFromError(err);
          this.lastDiagnostic = synthDiagnostic;
          console.warn(`❌ Edge TTS synth attempt ${attempt + 1}/${EDGETTS_SYNTH_RETRIES + 1} failed: ${formatProviderDiagnostic(synthDiagnostic)}`);
        }
      }

      if (synthDiagnostic) {
        // Synthesis failed after all retries → a genuine provider failure.
        recordProviderFailure('edgetts');
        if (synthDiagnostic.reason === 'timeout') {
          console.warn(`⏱️  Edge TTS timeout after ${synthDiagnostic.timeout_ms}ms (${EDGETTS_SYNTH_RETRIES} retries exhausted; elapsed ${synthDiagnostic.elapsed_ms}ms)`);
        } else {
          console.error(`❌ Edge TTS synthesis error: ${formatProviderDiagnostic(synthDiagnostic)}`);
        }
        return false;
      }

      // Defense-in-depth: only treat this as success if a synthesis attempt
      // actually ran (tmp is set per attempt). A degenerate loop that ran zero
      // iterations must NOT report a false success and mask a real outage.
      if (!tmp) {
        this.lastDiagnostic = { phase: 'synthesis', reason: 'no-attempt', message: 'no synthesis attempt ran' };
        recordProviderFailure('edgetts');
        console.error('❌ Edge TTS: no synthesis attempt ran');
        return false;
      }

      // The online provider did its job — mark it healthy regardless of what
      // happens during local playback below.
      recordProviderSuccess('edgetts');
      const edgeSlot = audioCapture.getStore();
      if (edgeSlot) edgeSlot.synth_duration_ms = Date.now() - synthStart;

      // Persist short, repeated phrases so the next occurrence (e.g. the next
      // session's catchphrase) skips synthesis entirely. Best-effort; the
      // helper no-ops for long/unique text and never throws.
      writeTtsCache(edgettsVoice, rate, processedText, tmp!.file);

      // --- Playback (a LOCAL concern: afplay/mpv). A playback failure must NOT
      //     open the edge-tts breaker — the provider already succeeded. ---
      const player = process.platform === 'darwin' ? '/usr/bin/afplay' : 'mpv';
      const playStart = Date.now();
      try {
        const play = spawn(player, [tmp!.file]);
        await waitForProcess(play, player, AUDIO_PROCESS_TIMEOUT_MS);
        recordPlayback(tmp!.file, playStart, Date.now(), { exitCode: 0 });
      } catch (playError: any) {
        recordPlayback(tmp!.file, playStart, Date.now(), { exitCode: null, error: playError });
        this.lastDiagnostic = { phase: 'playback', reason: 'local-playback-failed', message: playError.message || String(playError), command: player };
        console.error(`🔇 Edge TTS playback failed via ${player} (local issue, provider unaffected):`, playError.message || playError);
        return false;
      }

      this.lastDiagnostic = undefined;
      console.log('✅ Edge TTS completed');
      return true;
    } finally {
      if (tmp) cleanupAudioTempDir(tmp.dir);
    }
  }
}

// --- macOS Say Provider ---
class MacOSSayProvider implements TTSProvider {
  name = 'say';

  isEnabled(): boolean {
    return voicesConfig.providers.say.enabled !== false;
  }

  async isHealthy(): Promise<boolean> {
    return true; // Always available on macOS
  }

  async speak(text: string): Promise<boolean> {
    try {
      const fallbackVoice = getMacOSFallbackVoice();
      console.log(`🍎 Using macOS say (voice: ${fallbackVoice})...`);

      const proc = spawn('/usr/bin/say', [
        '-v', fallbackVoice,
        '-r', String(voicesConfig.default_rate || 175),
        text
      ]);

      await waitForProcess(proc, 'say', AUDIO_PROCESS_TIMEOUT_MS);

      console.log('🍎 macOS say completed');
      return true;
    } catch (error) {
      console.error('🍎 macOS say failed:', error);
      return false;
    }
  }
}

// --- ElevenLabs Provider ---
class ElevenLabsProvider implements TTSProvider {
  name = 'elevenlabs';
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = resolveEnvVar(voicesConfig.providers.elevenlabs.apiKey) || resolveEchoEnv("ELEVENLABS_API_KEY");
  }

  isEnabled(): boolean {
    return voicesConfig.providers.elevenlabs.enabled === true && !!this.apiKey;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.apiKey) return false;
    if (shouldSkipProvider('elevenlabs')) return false;
    return true;
  }

  async speak(text: string, voiceId?: string, voiceSettings?: VoiceSettings): Promise<boolean> {
    if (!this.apiKey) return false;

    // Apply pronunciations before sending to ElevenLabs
    const pronouncedText = applyPronunciations(text);
    if (pronouncedText !== text) {
      console.log(`📖 Pronunciation applied: "${text}" → "${pronouncedText}"`);
    }

    const voice = voiceId || voicesConfig.providers.elevenlabs.defaultVoiceId || 's3TPKV1kjDlVtZbl4Ksh';

    const settings = {
      stability: voiceSettings?.stability ?? 0.5,
      similarity_boost: voiceSettings?.similarity_boost ?? 0.75,
      style: voiceSettings?.style ?? 0.0,
      use_speaker_boost: voiceSettings?.use_speaker_boost ?? true,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);

    try {
      console.log(`🎙️  ElevenLabs speaking (voice: ${voice})...`);

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text: pronouncedText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: settings,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      await playAudio(audioBuffer, 'mp3');
      recordProviderSuccess('elevenlabs');
      console.log('✅ ElevenLabs speech completed');
      return true;
    } catch (error: any) {
      recordProviderFailure('elevenlabs');

      const isTimeout = error.name === 'AbortError' ||
                        error.message?.includes('timeout') ||
                        error.message?.includes('Timeout');

      if (isTimeout) {
        console.warn(`⏱️  ElevenLabs timeout after ${ELEVENLABS_TIMEOUT_MS}ms`);
      } else {
        console.error('❌ ElevenLabs error:', error.message || error);
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// --- Kokoro Provider ---
class KokoroProvider implements TTSProvider {
  name = 'kokoro';

  isEnabled(): boolean {
    return voicesConfig.providers.kokoro.enabled === true;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (shouldSkipProvider('kokoro')) return false;

    const endpoint = voicesConfig.providers.kokoro.endpoint || 'http://127.0.0.1:8880/v1';

    try {
      const response = await fetch(`${endpoint}/models`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async speak(text: string, voice?: string, voiceSettings?: VoiceSettings): Promise<boolean> {
    const endpoint = voicesConfig.providers.kokoro.endpoint || 'http://127.0.0.1:8880/v1';
    const kokoroVoice = voice || voicesConfig.providers.kokoro.defaultVoice || 'af_sky';
    const speed = voiceSettings?.speed ?? 1.0;

    // Apply pronunciations before sending to Kokoro
    const pronouncedText = applyPronunciations(text);
    if (pronouncedText !== text) {
      console.log(`📖 Pronunciation applied: "${text}" → "${pronouncedText}"`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), KOKORO_TIMEOUT_MS);

    try {
      console.log(`🎵 Kokoro speaking (voice: ${kokoroVoice}, speed: ${speed})...`);

      const response = await fetch(`${endpoint}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'kokoro',
          input: pronouncedText,
          voice: kokoroVoice,
          speed: speed,
          response_format: 'mp3'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Kokoro API returned ${response.status}: ${response.statusText}`);
      }

      const audioBuffer = await response.arrayBuffer();
      await playAudio(audioBuffer, 'mp3');
      recordProviderSuccess('kokoro');
      console.log('✅ Kokoro speech completed');
      return true;
    } catch (error: any) {
      recordProviderFailure('kokoro');

      const isTimeout = error.name === 'AbortError' ||
                        error.message?.includes('timeout') ||
                        error.message?.includes('Timeout');

      if (isTimeout) {
        console.warn(`⏱️  Kokoro timeout after ${KOKORO_TIMEOUT_MS}ms`);
      } else {
        console.error('❌ Kokoro error:', error.message || error);
      }
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// =============================================================================
// Provider Management
// =============================================================================

export const providers: Record<string, TTSProvider> = {
  edgetts: new EdgeTTSProvider(),
  elevenlabs: new ElevenLabsProvider(),
  kokoro: new KokoroProvider(),
  say: new MacOSSayProvider(),
};

// Per-provider egress destination for the /health audit (issue #26). A provider
// makes an outbound network request only when ENABLED: edge-tts and ElevenLabs
// always leave the host; Kokoro contacts its configured endpoint (local by
// default — the returned value makes locality visible); macOS `say` is fully
// local and never returns a target. The disabled-provider no-egress guarantee
// is therefore auditable: wouldEgress is false whenever a provider is disabled.
function egressTargetFor(name: string): string | undefined {
  switch (name) {
    case 'edgetts': return 'Microsoft Edge TTS (online)';
    case 'elevenlabs': return 'api.elevenlabs.io';
    case 'kokoro': return voicesConfig.providers.kokoro.endpoint || 'http://127.0.0.1:8880/v1';
    default: return undefined; // 'say' and any other local-only provider
  }
}

type ProviderStatus = {
  enabled: boolean;
  healthy: boolean;
  wouldEgress: boolean;
  egressTarget?: string;
  endpoint?: string;
  apiKeyConfigured?: boolean;
  health_diagnostic?: ProviderDiagnostic;
};

export async function getProviderStatus(): Promise<Record<string, ProviderStatus>> {
  const status: Record<string, ProviderStatus> = {};

  for (const [name, provider] of Object.entries(providers)) {
    const enabled = provider.isEnabled();
    const healthy = enabled ? await provider.isHealthy() : false;
    const egressTarget = egressTargetFor(name);
    // "Would egress" = currently configured such that using/probing this
    // provider makes an outbound network request. Gated on enabled, so a
    // disabled provider always reports false.
    const wouldEgress = enabled && egressTarget !== undefined;

    const diagnostic = provider.getLastDiagnostic?.();

    status[name] = {
      enabled,
      healthy,
      wouldEgress,
      ...(wouldEgress && { egressTarget }),
      ...(diagnostic && !healthy && { health_diagnostic: diagnostic }),
      ...(name === 'kokoro' && { endpoint: voicesConfig.providers.kokoro.endpoint }),
      ...(name === 'elevenlabs' && { apiKeyConfigured: !!resolveEnvVar(voicesConfig.providers.elevenlabs.apiKey) })
    };
  }

  return status;
}

// =============================================================================
// Voice-resolution drop-off log (issue #24)
//
// One structured JSONL event per /notify recording WHY a notification used the
// voice it did: the requested voice_id, how it resolved (agent key / elevenlabs
// id / identity / fallback), the provider + voice actually used, and any
// provider failures, circuit-breaker skips, or fallback hops along the way.
// This is a machine-readable diagnostics stream, kept SEPARATE from the
// human-readable daemon log (~/Library/Logs/echo.log).
//
// Retention: a single size-capped JSONL file. On each write the file is pruned
// back under the cap by dropping the oldest whole lines (newest always kept).
// No external deps, no logrotate, no time-based rotation. Writes are
// best-effort — a logging failure must NEVER break a /notify.
//
// Path: user-owned (macOS ~/Library/Logs, else $XDG_STATE_HOME / ~/.local/state),
// never /tmp, never the repo. Override with ECHO_RESOLUTION_LOG (legacy
// VOICESYSTEM_RESOLUTION_LOG kept as a silent fallback). Host-neutral: no
// host-adapter knowledge here.
//
// Resolved at write time (not frozen at module load) so a process that sets the
// override after import — e.g. a test setting ECHO_RESOLUTION_LOG before
// its first /notify — writes to the intended path regardless of import order.
// Production behavior is identical: env doesn't change at runtime, so every write
// resolves the same path the daemon would have captured at startup.
// =============================================================================

function resolveResolutionLogPath(): string {
  return resolveEchoEnv("ECHO_RESOLUTION_LOG") ?? resolveEchoEnv("VOICESYSTEM_RESOLUTION_LOG") ?? (
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Logs', 'echo', 'voice-resolution.jsonl')
      : join(resolveEchoEnv("XDG_STATE_HOME") || join(homedir(), '.local', 'state'), 'echo', 'voice-resolution.jsonl')
  );
}

// ~1MB cap (floor 1KB). Override via ECHO_RESOLUTION_LOG_MAX_BYTES (legacy
// VOICESYSTEM_RESOLUTION_LOG_MAX_BYTES kept as a silent fallback).
const RESOLUTION_LOG_MAX_BYTES = parseBoundedInt(resolveEchoEnv("ECHO_RESOLUTION_LOG_MAX_BYTES") ?? resolveEchoEnv("VOICESYSTEM_RESOLUTION_LOG_MAX_BYTES"), 1_000_000, 1024);

type AttemptOutcome = 'success' | 'failed' | 'unhealthy' | 'circuit-open' | 'disabled';

interface SpeakAttempt extends ProviderDiagnostic {
  provider: string;
  outcome: AttemptOutcome;
}

type ResolutionResult =
  | 'identity-default'  // no voice_id requested → identity voice
  | 'identity'          // voice_id matched the identity mapping
  | 'agent-key'         // voice_id matched an agents[<key>] entry
  | 'elevenlabs-id'     // voice_id matched an agent/identity by ElevenLabs voice id
  | 'edgetts-explicit'  // voice_id is a literal edge-tts voice name → spoken as-is by edgetts
  | 'fallback';         // voice_id did not resolve → provider default voice

interface ResolutionEvent {
  ts: string;
  requested_voice_id: string | null;
  resolution: ResolutionResult;
  resolution_reason?: string; // present only when resolution === 'fallback'
  provider: string;           // provider that spoke, or 'none'
  voice: string | null;       // actual voice used by that provider
  hops: number;               // providers skipped/failed before the chosen one
  attempts: SpeakAttempt[];   // per-provider outcome (failures, circuit-open, skips)
  success: boolean;
}

// Classify how a requested voice_id resolved. Derived from the VoiceMapping that
// getVoiceMapping already returned (not a re-query), mirroring its branch order
// so the log and the actual resolution can never disagree.
export function classifyResolution(
  requestedVoiceId: string | null,
  mapping: VoiceMapping | null,
): { resolution: ResolutionResult; reason?: string } {
  if (!requestedVoiceId) return { resolution: 'identity-default' };
  if (!mapping) {
    // A literal edge-tts voice name is honored by the edge provider (spoken
    // as-is), so it is NOT a fallback — classify it honestly.
    if (looksLikeEdgeVoice(requestedVoiceId)) return { resolution: 'edgetts-explicit' };
    return { resolution: 'fallback', reason: `voice_id "${requestedVoiceId}" did not match any agent or identity` };
  }
  if (mapping === voicesConfig.identity) return { resolution: 'identity' };
  if (voicesConfig.agents[requestedVoiceId] === mapping) return { resolution: 'agent-key' };
  return { resolution: 'elevenlabs-id' };
}

// Append one event, then roll the file back under the cap. Best-effort: all
// failures are swallowed so logging can never break a /notify.
export function writeResolutionEvent(
  event: ResolutionEvent,
  path: string = resolveResolutionLogPath(),
  maxBytes: number = RESOLUTION_LOG_MAX_BYTES,
): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, JSON.stringify(event) + '\n');
    pruneResolutionLog(path, maxBytes);
  } catch {
    // swallow — diagnostics logging must never break a notification
  }
}

// Rolling prune: if the file exceeds maxBytes, drop the oldest whole lines until
// it fits, always keeping the newest line. O(n) in line count.
function pruneResolutionLog(path: string, maxBytes: number): void {
  if (statSync(path).size <= maxBytes) return;
  const encoded = readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l + '\n');
  const sizes = encoded.map((s) => Buffer.byteLength(s));
  let total = sizes.reduce((a, b) => a + b, 0);
  let start = 0;
  while (start < encoded.length - 1 && total > maxBytes) {
    total -= sizes[start];
    start++;
  }
  writeFileSync(path, encoded.slice(start).join(''));
}

// =============================================================================
// Core: speakWithFallback — provider chain with pronunciation + emotion support
//
// Voice settings resolution (3-tier):
//   1. callerVoiceSettings provided → use directly (pass-through)
//   2. voiceId provided → look up voice mapping in voices.json
//   3. Neither → use voices.json identity defaults
//
// Emotional overlay applies AFTER settings resolution, modifying
// stability + similarity_boost for the matched emotion.
// =============================================================================

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.0,
  speed: 1.0,
  use_speaker_boost: true,
};

export async function speakWithFallback(
  text: string,
  voiceId?: string,
  callerVoiceSettings?: Partial<VoiceSettings> | null,
  emotion?: string,
): Promise<{ success: boolean; provider: string; voice: string | null; attempts: SpeakAttempt[]; muted?: boolean; held_for_capture?: boolean }> {
  // Runtime mute gate (#83): sits before the provider loop so ONE check covers
  // every provider including the macOS `say` fallback. Lazy expiry — a timed
  // mute past its deadline reads as unmuted. Logging and voice resolution
  // already happened upstream; the caller records the drop-off event tagged muted.
  const muteState = readMuteState();
  if (muteState.muted) {
    console.log(`🔇 Muted — speech suppressed${muteState.muted_until ? ` until ${muteState.muted_until}` : ''}`);
    return { success: false, provider: 'muted', voice: null, attempts: [], muted: true };
  }

  // Capture guard: while an external tool has the mic open (its published
  // recording-state file says recording/transcribing from a live pid), speaking
  // would pollute the user's capture — skip the voice line, mute-style. Checked
  // at speak time (queue-dequeue), so a line whose turn arrives after the
  // capture ends plays normally. The banner already fired at accept.
  if (isCaptureActive()) {
    console.log('🎙️  Mic capture active — speech held (capture guard)');
    return { success: false, provider: 'capture-held', voice: null, attempts: [], held_for_capture: true };
  }

  // Build provider order: primary first, then fallback order
  const providerOrder = [
    voicesConfig.defaultProvider,
    ...voicesConfig.fallbackOrder.filter(p => p !== voicesConfig.defaultProvider)
  ];

  // Get voice mapping for this voice identifier
  const voiceMapping = getVoiceMapping(voiceId || null);

  // Per-provider outcomes, in order, for the resolution drop-off log (#24).
  const attempts: SpeakAttempt[] = [];

  for (const providerName of providerOrder) {
    const provider = providers[providerName];
    if (!provider) continue;

    if (!provider.isEnabled()) {
      console.log(`⏭️  Skipping ${providerName} (disabled)`);
      attempts.push({ provider: providerName, outcome: 'disabled' });
      continue;
    }

    // Edge health probes are diagnostic only. On the hot /notify path, Edge is
    // skipped only when config disables it or its circuit breaker is open from
    // real synthesis failures; a slow Python import probe must not force `say`.
    if (providerName === 'edgetts') {
      const breaker = circuitBreakers.edgetts;
      if (shouldSkipProvider('edgetts')) {
        const cooldownRemainingMs = Math.max(0, CIRCUIT_BREAKER_RESET_MS - (Date.now() - breaker.lastFailure));
        console.log(`⏭️  Skipping edgetts (circuit-open, retry in ${cooldownRemainingMs}ms)`);
        attempts.push({
          provider: providerName,
          outcome: 'circuit-open',
          phase: 'circuit-breaker',
          reason: 'open',
          message: `${breaker.failures} failures; retry in ${cooldownRemainingMs}ms`,
        });
        continue;
      }
    } else {
      const healthy = await provider.isHealthy();
      if (!healthy) {
        // An unhealthy skip is attributed to the circuit breaker when its breaker
        // is open (the health probe consults shouldSkipProvider); otherwise it's a
        // genuine health-probe failure.
        const outcome: AttemptOutcome = circuitBreakers[providerName]?.isOpen ? 'circuit-open' : 'unhealthy';
        const diagnostic = provider.getLastDiagnostic?.();
        console.log(`⏭️  Skipping ${providerName} (${outcome}${diagnostic ? `: ${formatProviderDiagnostic(diagnostic)}` : ''})`);
        attempts.push({ provider: providerName, outcome, ...(diagnostic ?? {}) });
        continue;
      }
    }

    // --- 3-tier voice settings resolution ---
    let providerVoice: string | undefined;
    let providerSettings: VoiceSettings;

    if (callerVoiceSettings && Object.keys(callerVoiceSettings).length > 0) {
      // Tier 1: caller passed explicit voice_settings → pass through
      providerSettings = {
        stability: callerVoiceSettings.stability ?? DEFAULT_VOICE_SETTINGS.stability,
        similarity_boost: callerVoiceSettings.similarity_boost ?? DEFAULT_VOICE_SETTINGS.similarity_boost,
        style: callerVoiceSettings.style ?? DEFAULT_VOICE_SETTINGS.style,
        speed: callerVoiceSettings.speed ?? DEFAULT_VOICE_SETTINGS.speed,
        use_speaker_boost: callerVoiceSettings.use_speaker_boost ?? DEFAULT_VOICE_SETTINGS.use_speaker_boost,
      };
      if (providerName === 'kokoro' && voiceMapping?.kokoro) {
        providerVoice = voiceMapping.kokoro.voice;
      } else if (providerName === 'elevenlabs' && voiceMapping?.elevenlabs) {
        providerVoice = voiceMapping.elevenlabs.voice_id;
      } else if (providerName === 'edgetts' && voiceMapping?.edgetts) {
        providerVoice = voiceMapping.edgetts.voice;
      }
      console.log(`🔗 Voice settings: pass-through from caller`);
    } else if (voiceMapping) {
      // Tier 2: resolve from voices.json mapping for this provider
      if (providerName === 'kokoro' && voiceMapping.kokoro) {
        providerVoice = voiceMapping.kokoro.voice;
        providerSettings = { ...DEFAULT_VOICE_SETTINGS, speed: voiceMapping.kokoro.speed ?? 1.0 };
      } else if (providerName === 'elevenlabs' && voiceMapping.elevenlabs) {
        providerVoice = voiceMapping.elevenlabs.voice_id;
        providerSettings = {
          stability: voiceMapping.elevenlabs.stability ?? DEFAULT_VOICE_SETTINGS.stability,
          similarity_boost: voiceMapping.elevenlabs.similarity_boost ?? DEFAULT_VOICE_SETTINGS.similarity_boost,
          style: voiceMapping.elevenlabs.style ?? DEFAULT_VOICE_SETTINGS.style,
          speed: DEFAULT_VOICE_SETTINGS.speed,
          use_speaker_boost: voiceMapping.elevenlabs.use_speaker_boost ?? DEFAULT_VOICE_SETTINGS.use_speaker_boost,
        };
      } else if (providerName === 'edgetts' && voiceMapping.edgetts) {
        providerVoice = voiceMapping.edgetts.voice;
        providerSettings = { ...DEFAULT_VOICE_SETTINGS, speed: voiceMapping.edgetts.speed ?? 1.0 };
      } else {
        providerSettings = { ...DEFAULT_VOICE_SETTINGS };
      }
    } else {
      // Tier 3: defaults
      providerSettings = { ...DEFAULT_VOICE_SETTINGS };
    }

    if (!providerVoice && providerName === 'elevenlabs' && voiceId && !voiceMapping) {
      providerVoice = voiceId;
    }

    // An explicit edge-tts voice name passed as voice_id (no voices.json agent
    // entry) is spoken literally by the edge provider — otherwise it would fall
    // to the default voice. This is how a project persona's configured voice
    // (e.g. "en-US-AndrewNeural") reaches the wire without a core/voices.json edit.
    if (!providerVoice && providerName === 'edgetts' && !voiceMapping && looksLikeEdgeVoice(voiceId)) {
      providerVoice = voiceId;
    }

    // Emotional overlay — modifies stability + similarity_boost on top of resolved settings
    if (emotion && EMOTIONAL_PRESETS[emotion]) {
      providerSettings = {
        ...providerSettings,
        stability: EMOTIONAL_PRESETS[emotion].stability,
        similarity_boost: EMOTIONAL_PRESETS[emotion].similarity_boost,
      };
      console.log(`🎭 Emotion overlay: ${emotion} (stability: ${providerSettings.stability}, boost: ${providerSettings.similarity_boost})`);
    }

    let success = false;
    try {
      success = await provider.speak(text, providerVoice, providerSettings);
    } catch (error: any) {
      console.error(`❌ ${providerName} provider threw:`, error.message || error);
      success = false;
    }
    if (success) {
      attempts.push({ provider: providerName, outcome: 'success' });
      // `say` ignores its voice arg and resolves the macOS fallback voice
      // internally (getMacOSFallbackVoice), so providerVoice is unset for it —
      // log that real voice rather than null on the most common drop-off path.
      const actualVoice = providerName === 'say' ? getMacOSFallbackVoice() : (providerVoice ?? null);
      return { success: true, provider: providerName, voice: actualVoice, attempts };
    }
    attempts.push({ provider: providerName, outcome: 'failed', ...(provider.getLastDiagnostic?.() ?? {}) });
  }

  return { success: false, provider: 'none', voice: null, attempts };
}

// =============================================================================
// Notification handlers — banner at accept time, speech via the play queue
// =============================================================================

// Fire the macOS banner immediately, OUTSIDE the play queue: a banner is not
// audio, must never wait behind playback, and a superseded/dropped voice line
// keeps its visual notification. Best-effort fire-and-forget, bounded by the
// osascript process timeout; a banner failure never affects the request.
function showBanner(sanitizedTitle: string, sanitizedMessage: string): void {
  try {
    const visible = stripMarkers(extractEmotionalMarker(sanitizedMessage).cleaned);
    const script = `display notification "${escapeForAppleScript(visible)}" with title "${escapeForAppleScript(sanitizedTitle)}" sound name ""`;
    void spawnSafe('/usr/bin/osascript', ['-e', script])
      .catch((error) => console.error("Notification display error:", error));
  } catch (error) {
    console.error("Notification display error:", error);
  }
}

// The play queue's injected player: speak one line and record its resolution
// + lifecycle rows. Errors propagate to the queue's onPlayerError (which logs
// and writes the failure row) — no internal swallow.
async function speakNotification(
  message: string,
  voiceId: string | null = null,
  callerVoiceSettings?: Partial<VoiceSettings> | null,
  sessionId: string | null = null,
  requestId: string | null = null,
) {
  const messageValidation = validateInput(message);
  if (!messageValidation.valid) {
    throw new Error(`Invalid message: ${messageValidation.error}`);
  }

  // Extract emotional marker before generic bracket stripping; otherwise
  // markers like [🎯 focused] are removed before they can affect TTS settings.
  const { cleaned, emotion } = extractEmotionalMarker(messageValidation.sanitized!);
  const safeMessage = stripMarkers(cleaned);

  if (emotion) {
    console.log(`🎭 Detected emotion: ${emotion}`);
  }

  const voiceMapping = getVoiceMapping(voiceId);
  if (voiceMapping?.description) {
    console.log(`👤 Voice: ${voiceMapping.description}`);
  }

  console.log(`🎙️  Speaking...`);

  // Run the speak inside an audio-capture context so the playback sites
  // (playAudio + the inline edgetts path) deposit their measured metrics
  // into this per-request slot (Phase 1 / U2). ALS isolates concurrent
  // /notify requests.
  const audioSlot: AudioCaptureSlot = {};
  const result = await audioCapture.run(audioSlot, () =>
    speakWithFallback(safeMessage, voiceId || undefined, callerVoiceSettings, emotion));

  if (result.muted) {
    console.log('🔇 Speech suppressed (muted)');
  } else if (result.success) {
    console.log(`✅ Speech via ${result.provider}`);
  } else {
    console.warn('⚠️  All speech providers failed');
  }

  // One structured resolution drop-off event per /notify (#24). Self-swallows
  // its own errors; never breaks the notification.
  const { resolution, reason } = classifyResolution(voiceId, voiceMapping);
  writeResolutionEvent({
    ts: logTimestamp(),
    requested_voice_id: voiceId,
    resolution,
    ...(reason && { resolution_reason: reason }),
    provider: result.provider,
    voice: result.voice,
    hops: result.success ? result.attempts.length - 1 : result.attempts.length,
    attempts: result.attempts,
    success: result.success,
    ...(result.muted && { muted: true }),
    ...(result.held_for_capture && { held_for_capture: true }),
  });

  // Audio lifecycle event (Phase 1 / R1): pairs the request context with the
  // playback metrics deposited by the playback sites, so truncation becomes
  // visible — a short play shows play_time_ms < clip_duration_s. Correlates
  // with the hook's voice-events.jsonl by session_id. Best-effort.
  const event: AudioLifecycleEvent = {
    ts: logTimestamp(),
    session_id: sessionId,
    request_id: requestId,
    message_chars: safeMessage.length,
    provider: result.provider,
    synth_duration_ms: audioSlot.synth_duration_ms ?? null,
    clip_duration_s: audioSlot.clip_duration_s ?? null,
    play_started_at: audioSlot.play_started_at ?? null,
    play_ended_at: audioSlot.play_ended_at ?? null,
    play_time_ms: audioSlot.play_time_ms ?? null,
    exit_reason: audioSlot.exit_reason ?? null,
    muted: result.muted ?? false,
    success: result.success,
    // Reached the player (Phase 2 / R7) — unless the capture guard held it
    // there: 'held-for-capture' keeps every 202-acked line's fate greppable.
    disposition: result.held_for_capture ? 'held-for-capture' : 'played',
  };
  writeAudioLifecycleEvent(event);
}

// =============================================================================
// Rate Limiting
// =============================================================================

const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(ip);

  if (!record || now > record.resetTime) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }

  if (record.count >= RATE_LIMIT) {
    return false;
  }

  record.count++;
  return true;
}

// =============================================================================
// Play Queue — global playback serialization (#202 receipt + plan R7 no-overlap)
// =============================================================================
//
// One queue per daemon: /notify (and the /notify/personality shim) validate,
// fire the banner, enqueue VOICE lines only, and ack 202 on receipt (R2); this
// single consumer speaks one line at a time via speakNotification (R1/KTD4).
// Queued lines coalesce newest-per-session (R4) and age out at dequeue (R5);
// both outcomes are recorded in the audio-lifecycle log as minimal disposition
// rows (R7). A hung player is bounded by the queue's watchdog, and liveness is
// visible in /health. Knobs: ECHO_PLAY_QUEUE_AGE_CAP_MS /
// ECHO_PLAY_QUEUE_MAX_DEPTH / ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS.

// Voice lines ONLY — banner-only notifications never enter the queue (the
// banner fires at accept time in acceptNotification), so they can never
// supersede, delay, or evict a queued voice line.
interface NotifyJobPayload {
  message: string;
  voiceId: string | null;
  voiceSettings: Partial<VoiceSettings> | null;
  sessionId: string | null;
  requestId: string;
  messageChars: number; // sanitized length, for disposition rows that never play
}

const playQueue = new PlayQueue<NotifyJobPayload>({
  player: async (job) => {
    const p = job.payload;
    await speakNotification(p.message, p.voiceId, p.voiceSettings, p.sessionId, p.requestId);
    log('info', `✅ Notification delivered`, { requestId: p.requestId, sessionId: p.sessionId });
  },
  onDisposition: (job, disposition, reason) => {
    log('info', `⏭️  Notification ${disposition} (${reason})`, { requestId: job.id, sessionId: job.sessionId });
    // Minimal lifecycle row (R7): the line never reached the player, so there
    // are no playback metrics — just the disposition and its reason.
    // message_chars here is the validation-sanitized length (pre marker-strip),
    // slightly larger than a played row's post-strip count.
    writeAudioLifecycleEvent({
      ts: logTimestamp(),
      session_id: job.sessionId,
      request_id: job.id,
      message_chars: job.payload.messageChars,
      provider: 'none',
      synth_duration_ms: null,
      clip_duration_s: null,
      play_started_at: null,
      play_ended_at: null,
      play_time_ms: null,
      exit_reason: null,
      muted: false,
      success: false,
      disposition,
      disposition_reason: reason,
    });
  },
  onPlayerError: (job, error) => {
    log('error', `Playback failed: ${error instanceof Error ? error.message : error}`, { requestId: job.id, sessionId: job.sessionId });
    // Failure row (R7): speakNotification does not swallow — a speak-path
    // throw or a watchdog timeout lands here, and without this row the
    // 202-acked line would vanish from the log entirely.
    writeAudioLifecycleEvent({
      ts: logTimestamp(),
      session_id: job.sessionId,
      request_id: job.id,
      message_chars: job.payload.messageChars,
      provider: 'none',
      synth_duration_ms: null,
      clip_duration_s: null,
      play_started_at: null,
      play_ended_at: null,
      play_time_ms: null,
      exit_reason: 'error',
      muted: false,
      success: false,
      disposition: 'played', // it reached the player; the play itself failed
    });
  },
});

// Test/introspection seam: resolves once every accepted voice line has
// settled (queue empty, nothing in flight). Banner-only notifications never
// enqueue, so they need no draining — their osascript spawn fires at accept.
export async function drainNotifications(): Promise<void> {
  await playQueue.drain();
}

// Accept one notification: validate (4xx BEFORE any side effect), fire the
// banner immediately (never queued), and enqueue the line for speech only
// when voice is enabled. Shared by /notify and the personality shim so their
// validation + payload semantics cannot drift apart.
function acceptNotification(
  reqId: string,
  opts: {
    title: string;
    message: string;
    voiceEnabled: boolean;
    voiceId: string | null;
    voiceSettings: Partial<VoiceSettings> | null;
    sessionId: string | null;
  },
): void {
  const titleValidation = validateInput(opts.title);
  if (!titleValidation.valid) {
    throw new Error(`Invalid title: ${titleValidation.error}`);
  }
  const messageValidation = validateInput(opts.message);
  if (!messageValidation.valid) {
    throw new Error(`Invalid message: ${messageValidation.error}`);
  }

  // Banner for every accepted notification, voice or not — decoupled from
  // the queue so it shows immediately and survives supersede/age-drop.
  showBanner(titleValidation.sanitized!, messageValidation.sanitized!);

  if (!opts.voiceEnabled) return;

  playQueue.enqueue({
    id: reqId,
    sessionId: opts.sessionId,
    receivedAt: Date.now(),
    payload: {
      message: opts.message,
      voiceId: opts.voiceId,
      voiceSettings: opts.voiceSettings,
      sessionId: opts.sessionId,
      requestId: reqId,
      messageChars: messageValidation.sanitized!.length,
    },
  });
}

// =============================================================================
// HTTP Server
// =============================================================================

export const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const clientIp = req.headers.get('x-forwarded-for') || 'localhost';

    const corsHeaders = {
      "Access-Control-Allow-Origin": "http://localhost",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders, status: 204 });
    }

    // /mute gets its own rate-limit bucket (#83): a burst of /notify traffic
    // must never starve the mute control — the exact moment the user wants
    // silence is when notification traffic is heaviest.
    //
    // /voices gets its own bucket for the mirror-image reason: it is a cheap
    // in-memory read that adapters make once per turn, immediately before the
    // /notify for that same turn. Sharing the notification bucket would halve
    // every host's effective notification budget and make the read starve the
    // write it precedes — a dropped notification, the worst failure here.
    const rateKey =
      url.pathname === "/mute" ? `mute:${clientIp}`
      : url.pathname === "/voices" ? `voices:${clientIp}`
      : clientIp;
    if (!checkRateLimit(rateKey)) {
      return new Response(
        JSON.stringify({ status: "error", message: "Rate limit exceeded" }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 429
        }
      );
    }

    if (url.pathname === "/notify" && req.method === "POST") {
      const reqId = generateRequestId();
      try {
        const data = await req.json();
        const title = data.title || DEFAULT_NOTIFICATION_TITLE;
        const message = data.message || "Task completed";
        const voiceEnabled = data.voice_enabled !== false;
        const voiceId = data.voice_id || data.voice_name || null;
        const voiceSettings = data.voice_settings || null;
        const sessionId = data.session_id || null;
        const source = data.source || null;
        const ctx: LogContext = { requestId: reqId, sessionId, source };

        if (voiceId && typeof voiceId !== 'string') {
          throw new Error('Invalid voice_id');
        }

        // Validate synchronously so a bad request still gets a 4xx (not a 202).
        const titleCheck = validateInput(title);
        if (!titleCheck.valid) throw new Error(`Invalid title: ${titleCheck.error}`);
        const messageCheck = validateInput(message);
        if (!messageCheck.valid) throw new Error(`Invalid message: ${messageCheck.error}`);

        log('info', `📨 Notification: "${title}" - "${message}" (voice: ${voiceEnabled}, provider: ${voicesConfig.defaultProvider})`, ctx);

        // 202 on receipt: the banner fires at accept, and synth+play runs
        // async in the play queue's single consumer so the hook never blocks
        // on synthesis (#202) and concurrent notifications never overlap
        // (plan R7). True playback outcome lives in the audio-lifecycle log.
        acceptNotification(reqId, { title, message, voiceEnabled, voiceId, voiceSettings, sessionId });

        log('info', `📥 Notification accepted (queue depth: ${playQueue.depth})`, ctx);
        return new Response(
          JSON.stringify({ status: "accepted", message: "Notification queued", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 202
          }
        );
      } catch (error: any) {
        log('error', `Notification error: ${error.message || error}`, { requestId: reqId });
        return new Response(
          JSON.stringify({ status: "error", message: error.message || "Internal server error", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: error.message?.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    // /notify/personality — compatibility shim
    if (url.pathname === "/notify/personality" && req.method === "POST") {
      const reqId = generateRequestId();
      try {
        const data = await req.json();
        const message = data.message || "Notification";
        const ctx: LogContext = { requestId: reqId, sessionId: data.session_id, source: data.source };

        const messageCheck = validateInput(message);
        if (!messageCheck.valid) throw new Error(`Invalid message: ${messageCheck.error}`);

        log('info', `🎭 Personality notification queued: "${message}"`, ctx);

        // Same global queue as /notify: one voice at a time across every
        // entry point (R1). Ack 202 on receipt (R2).
        acceptNotification(reqId, {
          title: DEFAULT_NOTIFICATION_TITLE, message, voiceEnabled: true,
          voiceId: null, voiceSettings: null, sessionId: data.session_id || null,
        });

        return new Response(
          JSON.stringify({ status: "accepted", message: "Personality notification queued", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 202
          }
        );
      } catch (error: any) {
        log('error', `Personality notification error: ${error.message || error}`, { requestId: reqId });
        return new Response(
          JSON.stringify({ status: "error", message: error.message || "Internal server error", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: error.message?.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    // /mute — global runtime mute (#83). An explicit JSON body sets state;
    // an EMPTY body toggles, so a one-keystroke hotkey needs no state
    // knowledge. Response is always the resulting state {muted, muted_until}.
    if (url.pathname === "/mute" && req.method === "POST") {
      const reqId = generateRequestId();
      try {
        const text = await req.text();
        let state;
        if (text.trim() === "") {
          state = toggleMuteState();
        } else {
          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error("Invalid JSON body");
          }
          if (typeof data?.muted !== "boolean") {
            throw new Error("Invalid body: 'muted' must be a boolean");
          }
          if (data.duration_minutes !== undefined &&
              (typeof data.duration_minutes !== "number" || !Number.isFinite(data.duration_minutes) || data.duration_minutes <= 0)) {
            throw new Error("Invalid body: 'duration_minutes' must be a positive number");
          }
          state = setMuteState(data.muted, data.duration_minutes);
        }

        log('info', `🔇 Mute ${state.muted ? 'ON' : 'OFF'}${state.muted_until ? ` until ${state.muted_until}` : ''}`, { requestId: reqId });
        return new Response(
          JSON.stringify(state),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          }
        );
      } catch (error: any) {
        log('error', `Mute error: ${error.message || error}`, { requestId: reqId });
        return new Response(
          JSON.stringify({ status: "error", message: error.message || "Internal server error", request_id: reqId }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: error.message?.includes('Invalid') ? 400 : 500
          }
        );
      }
    }

    // Read-only projection of the voice config a caller needs to decide whether a
    // `voice_id` will resolve. Adapters must not read the daemon's config files off
    // disk — a co-located checkout is not part of the contract, and the daemon may
    // be running from a different clone or a different VOICES_PATH than the adapter
    // sees. This is the supported way to ask "which persona keys exist?".
    if (url.pathname === "/voices" && req.method === "GET") {
      return new Response(
        JSON.stringify({
          agents: Object.keys(voicesConfig.agents ?? {}).sort(),
          default_provider: voicesConfig.defaultProvider,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (url.pathname === "/health" && req.method === "GET") {
      const providerStatus = await getProviderStatus();

      return new Response(
        JSON.stringify({
          status: "healthy",
          port: PORT,
          voice_system: `Multi-provider TTS (${voicesConfig.fallbackOrder.join(" → ")})`,
          config_source: "voices.json",
          activeProvider: voicesConfig.defaultProvider,
          providers: providerStatus,
          fallbackOrder: voicesConfig.fallbackOrder,
          macos_fallback_voice: getMacOSFallbackVoice(),
          pronunciation_rules: pronunciationRules.length,
          emotional_presets: Object.keys(EMOTIONAL_PRESETS).length,
          mute: readMuteState(),
          // Additive: the capture guard's resolved state file and current
          // reading (idle unless a live external mic capture is in progress).
          capture_guard: {
            path: resolveCaptureStatePath(),
            state: readCaptureState(),
          },
          // Additive (Phase 2): backlog + consumer liveness. `stalled` means
          // the current job has outlived even the queue's own watchdog —
          // the consumer is genuinely wedged, not just playing a long line.
          play_queue: {
            depth: playQueue.depth,
            in_flight_ms: playQueue.inFlightMs,
            stalled: playQueue.inFlightMs !== null && playQueue.inFlightMs > playQueue.playerTimeoutMs,
          },
          circuit_breakers: {
            edgetts: {
              open: circuitBreakers.edgetts.isOpen,
              failures: circuitBreakers.edgetts.failures,
            },
            elevenlabs: {
              open: circuitBreakers.elevenlabs.isOpen,
              failures: circuitBreakers.elevenlabs.failures,
            },
            kokoro: {
              open: circuitBreakers.kokoro.isOpen,
              failures: circuitBreakers.kokoro.failures,
            },
            threshold: CIRCUIT_BREAKER_THRESHOLD,
            reset_after_ms: CIRCUIT_BREAKER_RESET_MS,
          },
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        }
      );
    }

    const supported = ["POST /notify", "POST /notify/personality", "POST /mute", "GET /health", "GET /voices"];
    if (req.method === "POST") {
      return new Response(
        JSON.stringify({
          status: "error",
          message: `Unsupported endpoint: ${url.pathname}`,
          supported_endpoints: supported,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 404,
        },
      );
    }

    return new Response("Voice Server - POST to /notify or /notify/personality, GET /health for status, GET /voices for configured personas", {
      headers: corsHeaders,
      status: 404
    });
  },
});

// =============================================================================
// Startup Banner
// =============================================================================

const providerStatus = await getProviderStatus();

log('info', `🚀 Voice Server running on port ${PORT}`);
log('info', `📄 Config source: voices.json`);
log('info', `🎙️  Primary provider: ${voicesConfig.defaultProvider}`);
log('info', `📋 Fallback order: ${voicesConfig.fallbackOrder.join(' → ')}`);
log('info', `🔧 Provider status:`);
for (const [name, status] of Object.entries(providerStatus)) {
  const icon = status.healthy ? '✅' : (status.enabled ? '⚠️' : '⬚');
  log('info', `   ${icon} ${name}: ${status.enabled ? 'enabled' : 'disabled'}${status.healthy ? ', healthy' : ''}`);
}
log('info', `🍎 macOS fallback voice: ${getMacOSFallbackVoice()}`);
log('info', `📖 Pronunciation rules: ${pronunciationRules.length}`);
log('info', `🎭 Emotional presets: ${Object.keys(EMOTIONAL_PRESETS).length}`);
log('info', `⚡ Circuit breaker: ${CIRCUIT_BREAKER_THRESHOLD} failures → ${CIRCUIT_BREAKER_RESET_MS / 1000}s cooldown`);
log('info', `📡 Endpoints: POST /notify, POST /notify/personality, POST /mute, GET /health, GET /voices`);
log('info', `🔒 Security: CORS restricted to localhost, rate limiting enabled`);
