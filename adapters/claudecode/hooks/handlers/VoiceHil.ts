/**
 * Speak once when Claude Code is waiting on a human (#107).
 * Observe-only: never returns a PermissionRequest decision.
 */

import { existsSync, readFileSync } from "node:fs";
import { getIdentity } from "../lib/identity";
import { classifyClaudeHil, type ClaudeHilInput } from "../lib/hil-event";
import { extractPendingAskUserQuestion } from "../lib/TranscriptParser";
import { shouldSuppressSubagentVoice, loadEchoConfiguration, type EchoEnvironment } from "@echo/shared/echo-env.ts";
import {
  defaultHilDedupeDir,
  formatHilMessage,
  hilDedupeKey,
  preferredHumanName,
  HilDedupe,
} from "@echo/shared/hil.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { sendNotificationPayload, type NotifyPayload } from "@echo/shared/notify-client.ts";
import { detectSpeakMode } from "@echo/shared/speak-mode.ts";
import { createHookNativeVisualContext } from "../lib/native-terminal";

export interface HilSpeakDeps {
  env?: EchoEnvironment;
  dedupe?: HilDedupe;
  send?: (payload: NotifyPayload, sessionId: string) => Promise<{ ok: boolean }>;
  readTranscript?: (path: string) => string | null;
}

function defaultReadTranscript(path: string): string | null {
  try {
    if (!path || !existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function defaultSend(payload: NotifyPayload, sessionId: string): Promise<{ ok: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const result = await sendNotificationPayload(
      { endpoint: resolveNotifyUrl(loadEchoConfiguration()), title: payload.title },
      payload,
      controller.signal,
      createHookNativeVisualContext(sessionId),
    );
    return { ok: result.ok };
  } finally {
    clearTimeout(timeout);
  }
}

function transcriptHint(input: ClaudeHilInput, readTranscript: (path: string) => string | null) {
  if (!input.transcript_path) return undefined;
  const raw = readTranscript(input.transcript_path);
  if (raw === null) return undefined;
  const pending = extractPendingAskUserQuestion(raw);
  return {
    awaitingInput: pending !== null,
    question: pending?.question,
  };
}

export function isMainSessionHil(input: ClaudeHilInput): boolean {
  if (process.env.CLAUDE_CODE_AGENT_TASK_ID) return false;
  if (input.agent_id && shouldSuppressSubagentVoice()) return false;
  return true;
}

export async function handleHil(input: ClaudeHilInput, deps: HilSpeakDeps = {}): Promise<boolean> {
  if (!isMainSessionHil(input)) return false;

  const env = deps.env ?? loadEchoConfiguration();
  const hint = transcriptHint(input, deps.readTranscript ?? defaultReadTranscript);
  const candidate = classifyClaudeHil(input, hint);
  if (!candidate) return false;

  const sessionId = input.session_id || "ephemeral";
  const dedupe = deps.dedupe ?? new HilDedupe({ persistDir: defaultHilDedupeDir(env) });
  if (
    input.hook_event_name === "Notification" &&
    input.notification_type === "permission_prompt" &&
    dedupe.recentlyBegan(sessionId, candidate.kind, 30_000)
  ) {
    return false;
  }
  const key = hilDedupeKey(sessionId, candidate);
  if (!dedupe.tryBegin(key)) return false;

  const identity = getIdentity();
  const message = formatHilMessage({
    kind: candidate.kind,
    personaName: identity.displayName || identity.name,
    preferredName: preferredHumanName(env),
    prompt: candidate.prompt,
  });
  const payload: NotifyPayload = {
    message,
    title: `${identity.displayName || identity.name} says`,
    voice_enabled: true,
    session_id: sessionId,
    source: "claudecode",
    speak_mode: detectSpeakMode(message),
  };
  if (identity.mainDAVoiceID) payload.voice_id = identity.mainDAVoiceID;

  try {
    const result = await (deps.send ?? defaultSend)(payload, sessionId);
    if (!result.ok) {
      dedupe.release(key);
      return false;
    }
    return true;
  } catch (error) {
    dedupe.release(key);
    throw error;
  }
}
