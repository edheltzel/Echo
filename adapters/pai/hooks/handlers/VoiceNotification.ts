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
import type { ParsedTranscript } from '../lib/TranscriptParser';

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
  const daName = identity.displayName || identity.name || 'Atlas';
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
 * Detect the active main-session persona from the response's 🗣️ speaker tag.
 *
 * A main-session persona (e.g. adopting `/Themis`) is NOT a Task subagent, so
 * no env var signals it. The reliable per-turn signal is the response itself:
 * every turn ends with a `🗣️ <Name>:` line. We take the LAST such tag (the
 * voice line sits at the end) and return its lowercase name as the persona key.
 * Returns null when the speaker is the DA (Atlas) or no tag is present — those
 * keep the unchanged DA voice path.
 *
 * Self-cleaning: the moment the model stops emitting `🗣️ Themis:`, the next
 * turn resolves to null and reverts to the DA voice. No marker/registry state.
 */
export function resolvePersonaKey(text: string, daName: string): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(/🗣️\s*\*{0,2}([A-Za-z][A-Za-z0-9_-]*)\*{0,2}\s*:/g)];
  if (matches.length === 0) return null;
  const name = matches[matches.length - 1][1].toLowerCase();
  if (!name || name === daName.toLowerCase()) return null;
  return name;
}

interface VoiceSelection {
  voiceId: string;
  /** ElevenLabs prosody for the DA path; omitted for personas so the daemon applies the persona's own config. */
  voiceSettings?: VoiceProsody;
  /** Speaker label for the notification title. */
  speaker: string;
}

/**
 * Choose the voice for this turn. A main-session persona (signalled by its
 * `🗣️ <Name>:` tag) speaks in its own voice — we send the name key and let the
 * daemon resolve it (e.g. `themis` → en-US-MichelleNeural). Otherwise the DA
 * voice (mainDAVoiceID + prosody) — byte-for-byte the previous behavior.
 */
export function selectVoice(parsed: ParsedTranscript, identity: Identity): VoiceSelection {
  const text = parsed.currentResponseText || parsed.lastMessage || '';
  const personaKey = resolvePersonaKey(text, identity.name);
  if (personaKey) {
    return { voiceId: personaKey, speaker: personaKey };
  }
  return { voiceId: identity.mainDAVoiceID, voiceSettings: identity.voice, speaker: identity.name };
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
  // its own voice (name key → daemon resolves); otherwise the DA voice path is
  // byte-for-byte unchanged (mainDAVoiceID + prosody).
  const { voiceId, voiceSettings, speaker } = selectVoice(parsed, DA_IDENTITY);

  const payload: ElevenLabsNotificationPayload = {
    message: voiceCompletion,
    title: `${speaker} says`,
    voice_enabled: true,
    voice_id: voiceId,
    session_id: sessionId,
    source: 'pai',
    voice_settings: voiceSettings ? {
      stability: voiceSettings.stability ?? 0.5,
      similarity_boost: voiceSettings.similarity_boost ?? 0.75,
      style: voiceSettings.style ?? 0.0,
      speed: voiceSettings.speed ?? 1.0,
      use_speaker_boost: voiceSettings.use_speaker_boost ?? true,
    } : undefined,
  };

  await sendNotification(payload, sessionId);
}
