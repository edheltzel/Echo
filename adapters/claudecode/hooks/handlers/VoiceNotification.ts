/**
 * VoiceNotification.ts - Voice Notification Handler
 *
 * PURPOSE:
 * Sends completion messages to the voice server for TTS playback.
 * Extracts the 🗣️ voice line from responses and sends to ElevenLabs via voice server.
 *
 * Pure handler: receives pre-parsed transcript data, sends to voice server.
 * No I/O for transcript reading - that's done by orchestrator.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { paiPath } from '../lib/paths';
import { getIdentity, type Identity, type VoiceProsody, type VoicePersonality } from '../lib/identity';
import { getISOTimestamp } from '../lib/time';
import { isValidVoiceCompletion, getVoiceFallback } from '../lib/output-validators';
import { parseFinalVoiceLine, type ParsedTranscript } from '../lib/TranscriptParser';

const DA_IDENTITY = getIdentity();

// ElevenLabs voice notification payload
interface ElevenLabsNotificationPayload {
  message: string;
  title?: string;
  voice_enabled?: boolean;
  voice_id?: string;
  voice_settings?: {
    stability: number;
    similarity_boost: number;
    style: number;
    speed: number;
    use_speaker_boost: boolean;
  };
  volume?: number;
  session_id?: string;
  source?: string;
}

interface VoiceEvent {
  timestamp: string;
  session_id: string;
  event_type: 'sent' | 'failed' | 'skipped';
  message: string;
  character_count: number;
  voice_engine: 'elevenlabs';
  voice_id: string;
  status_code?: number;
  error?: string;
}

const VOICE_LOG_PATH = paiPath('MEMORY', 'VOICE', 'voice-events.jsonl');
const CURRENT_WORK_PATH = paiPath('MEMORY', 'STATE', 'current-work.json');

function getActiveWorkDir(): string | null {
  try {
    if (!existsSync(CURRENT_WORK_PATH)) return null;
    const content = readFileSync(CURRENT_WORK_PATH, 'utf-8');
    const state = JSON.parse(content);
    if (state.work_dir) {
      const workPath = paiPath('MEMORY', 'WORK', state.work_dir);
      if (existsSync(workPath)) return workPath;
    }
  } catch {
    // Silent fail
  }
  return null;
}

function logVoiceEvent(event: VoiceEvent): void {
  const line = JSON.stringify(event) + '\n';

  try {
    const dir = paiPath('MEMORY', 'VOICE');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(VOICE_LOG_PATH, line);
  } catch {
    // Silent fail
  }

  try {
    const workDir = getActiveWorkDir();
    if (workDir) {
      appendFileSync(join(workDir, 'voice.jsonl'), line);
    }
  } catch {
    // Silent fail
  }
}

function normalizeSpokenText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function startupCatchphrasesFromSettings(settings: any): string[] {
  const identity = settings.daidentity ?? {};
  const daName = identity.displayName || identity.name || DA_IDENTITY.displayName;
  const phrases = [
    identity.startupCatchphrase,
    ...(Array.isArray(identity.startupCatchphrases) ? identity.startupCatchphrases : []),
  ];

  return phrases
    .filter((phrase): phrase is string => typeof phrase === 'string' && phrase.trim().length > 0)
    .map((phrase) => phrase.replace(/\{name\}/gi, daName));
}

async function sendNotification(payload: ElevenLabsNotificationPayload, sessionId: string): Promise<void> {
  const voiceId = payload.voice_id || DA_IDENTITY.mainDAVoiceID;

  const baseEvent: Omit<VoiceEvent, 'event_type' | 'status_code' | 'error'> = {
    timestamp: getISOTimestamp(),
    session_id: sessionId,
    message: payload.message,
    character_count: payload.message.length,
    voice_engine: 'elevenlabs',
    voice_id: voiceId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000); // 12s: TTS gen (2-5s) + playback (3-6s) + margin

  const fetchStart = Date.now();
  console.error(`[Voice] fetch_start: "${payload.message.slice(0, 60)}..." (${payload.message.length} chars)`);

  try {
    // Use ElevenLabs voice server /notify endpoint
    const response = await fetch('http://localhost:8888/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const fetchMs = Date.now() - fetchStart;
    if (!response.ok) {
      console.error(`[Voice] fetch_fail: ${response.status} ${response.statusText} in ${fetchMs}ms`);
      logVoiceEvent({
        ...baseEvent,
        event_type: 'failed',
        status_code: response.status,
        error: response.statusText,
      });
    } else {
      console.error(`[Voice] fetch_ok: ${response.status} in ${fetchMs}ms`);
      logVoiceEvent({
        ...baseEvent,
        event_type: 'sent',
        status_code: response.status,
      });
    }
  } catch (error) {
    const fetchMs = Date.now() - fetchStart;
    const isAbort = error instanceof Error && error.name === 'AbortError';
    console.error(`[Voice] fetch_${isAbort ? 'abort' : 'fail'}: ${error} (${fetchMs}ms)`);
    logVoiceEvent({
      ...baseEvent,
      event_type: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Detect the active main-session persona from the response's 🗣️ voice line.
 *
 * A main-session persona (e.g. adopting `/Themis`) is NOT a Task subagent, so
 * no env var signals it. The reliable per-turn signal is the response itself:
 * by the host's MODES contract, the `🗣️ <Name>:` voice line is the FINAL line of
 * the response and sits at column 0 (a genuine voice line is never indented).
 *
 * We parse line-by-line (not regex over the whole string, which is fragile):
 *  - track fenced-code state with a delimiter toggle (``` and ~~~), so lines in
 *    a code block are ignored regardless of balance/closure;
 *  - treat Markdown indented code blocks (≥4 leading spaces or a tab) as code;
 *  - take the last non-blank, non-code line and accept a 🗣️ <Name>: tag only at
 *    column 0. So a demonstrated/quoted voice line (in a fence, indented block,
 *    list, or prose) can never win — pervasive in this repo's own docs.
 *
 * Self-cleaning: the moment the model stops emitting `🗣️ Themis:`, the next
 * turn resolves to null and reverts to the DA voice. No marker/registry state.
 *
 * NOTE: this only extracts the name — caller must still validate it against the
 * configured agents (see selectVoice) so an unknown name never becomes an
 * unresolvable voice_id (which would degrade to the daemon default, Ava).
 *
 * Line selection and name grammar are owned by parseFinalVoiceLine (shared with
 * the words extractor, so the voice and the spoken words always agree).
 */
export function resolvePersonaKey(text: string, daName: string): string | null {
  const voiceLine = parseFinalVoiceLine(text);
  if (!voiceLine) return null;
  const name = voiceLine.name.toLowerCase();
  if (!name || name === daName.toLowerCase()) return null;
  return name;
}

// Known persona keys from voices.json (same file the daemon resolves against).
// Cached per process — the Stop hook is a fresh process each turn.
let cachedAgentKeys: Set<string> | null = null;
export function loadKnownAgentKeys(): Set<string> {
  if (cachedAgentKeys) return cachedAgentKeys;
  try {
    // Mirror the daemon's resolution (core/server.ts): VOICES_PATH env override,
    // else core/voices.json relative to the repo root (this file lives at
    // adapters/claudecode/hooks/handlers/, so the root is four levels up).
    const voicesPath = process.env.VOICES_PATH || join(import.meta.dir, '..', '..', '..', '..', 'core', 'voices.json');
    const config = JSON.parse(readFileSync(voicesPath, 'utf-8'));
    cachedAgentKeys = new Set(Object.keys(config.agents ?? {}));
  } catch {
    // Can't read config → treat as "no known personas" so we never send an
    // unresolvable key; callers fall back to the DA voice.
    cachedAgentKeys = new Set();
  }
  return cachedAgentKeys;
}

/** Reset the voices.json key cache (test seam). */
export function clearAgentKeysCache(): void {
  cachedAgentKeys = null;
}

export interface VoiceSelection {
  voiceId: string;
  /** ElevenLabs prosody for the DA path; omitted for personas so the daemon applies the persona's own config. */
  voiceSettings?: VoiceProsody;
  /** Speaker label for the notification title. */
  speaker: string;
}

/**
 * Choose the voice for this turn. A main-session persona (signalled by its
 * `🗣️ <Name>:` voice line) speaks in its own voice — but ONLY when the resolved
 * name is a configured agent in voices.json; we send that name key and the
 * daemon resolves it (e.g. `themis` → en-US-MichelleNeural). An unknown name, a
 * DA line, or no line → the DA voice (mainDAVoiceID + prosody), byte-for-byte
 * the previous behavior. We never send an unresolvable key (which would degrade
 * to the daemon default, Ava — the exact bug this fixes).
 */
export function selectVoice(
  parsed: ParsedTranscript,
  identity: Identity,
  knownAgents: Set<string> = loadKnownAgentKeys(),
): VoiceSelection {
  const text = parsed.currentResponseText || parsed.lastMessage || '';
  const personaKey = resolvePersonaKey(text, identity.name);
  if (personaKey && knownAgents.has(personaKey)) {
    // Title shows the persona's display name (original-case tag, e.g. "Themis"),
    // while voice_id stays the lowercase key the daemon resolves (themis →
    // en-US-MichelleNeural). voices.json has no canonical display-name field, so
    // the tag's original-case name is the source. parseFinalVoiceLine is the same
    // canonical parser resolvePersonaKey used, so name/key can never disagree.
    const displayName = parseFinalVoiceLine(text)?.name ?? personaKey;
    return { voiceId: personaKey, speaker: displayName };
  }
  return { voiceId: identity.mainDAVoiceID, voiceSettings: identity.voice, speaker: identity.name };
}

/**
 * Build the voice-server payload for a resolved voice selection. Pure — keeps
 * the "what gets sent" decision testable without the network or settings I/O.
 */
export function buildVoicePayload(
  message: string,
  sessionId: string,
  selection: VoiceSelection,
): ElevenLabsNotificationPayload {
  const { voiceId, voiceSettings, speaker } = selection;
  return {
    message,
    title: `${speaker} says`,
    voice_enabled: true,
    voice_id: voiceId,
    session_id: sessionId,
    source: 'claudecode',
    voice_settings: voiceSettings ? {
      stability: voiceSettings.stability ?? 0.5,
      similarity_boost: voiceSettings.similarity_boost ?? 0.75,
      style: voiceSettings.style ?? 0.0,
      speed: voiceSettings.speed ?? 1.0,
      use_speaker_boost: voiceSettings.use_speaker_boost ?? true,
    } : undefined,
  };
}

/**
 * Handle voice notification with pre-parsed transcript data.
 * Uses ElevenLabs TTS via the voice server.
 */
export async function handleVoice(parsed: ParsedTranscript, sessionId: string): Promise<void> {
  let voiceCompletion = parsed.voiceCompletion;

  // Validate voice completion
  if (!isValidVoiceCompletion(voiceCompletion)) {
    console.error(`[Voice] Invalid completion: "${voiceCompletion.slice(0, 50)}..."`);
    voiceCompletion = getVoiceFallback();
  }

  // Skip empty or too-short messages
  if (!voiceCompletion || voiceCompletion.length < 5) {
    console.error('[Voice] Skipping - message too short or empty');
    return;
  }

  // Skip startup catchphrase — already spoken by VoiceGreeting.hook.ts at SessionStart.
  // Without this, the AI's first 🗣️ line echoing the greeting causes a double-fire.
  try {
    const settingsPath = join(process.env.HOME!, '.claude', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const normalized = normalizeSpokenText(voiceCompletion);
    for (const catchphrase of startupCatchphrasesFromSettings(settings)) {
      const catchNormalized = normalizeSpokenText(catchphrase);
      if (catchNormalized && (normalized === catchNormalized || normalized.includes(catchNormalized))) {
        console.error(`[Voice] Skipping - matches startup catchphrase: "${catchphrase}"`);
        return;
      }
    }
  } catch {
    // Settings read failed — continue with voice notification
  }

  // Resolve the speaker for this turn: an active main-session persona speaks in
  // its own voice (validated name key → daemon resolves); otherwise the DA voice
  // path is byte-for-byte unchanged (mainDAVoiceID + prosody).
  const selection = selectVoice(parsed, DA_IDENTITY);
  const payload = buildVoicePayload(voiceCompletion, sessionId, selection);

  await sendNotification(payload, sessionId);
}
