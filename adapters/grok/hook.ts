#!/usr/bin/env bun

/**
 * Grok Build lifecycle hook adapter.
 *
 * Reads Grok hook JSON from stdin (camelCase envelope from grok 1.0.0). Speaks
 * on Stop with reason == "end_turn" and optionally greets on SessionStart.
 * SubagentStop and non-end_turn Stop fires (session-end observe) stay silent.
 */

import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { applyNameToken } from "@echo/shared/greeting.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { extractVoiceLineFromText } from "@echo/shared/voice-line.ts";
import {
  loadGrokVoiceConfig,
  pickStartupCatchphrase,
  type GrokVoiceConfig,
} from "./config.ts";

/** Shape of the stdin envelope captured from grok 1.0.0 (3cd0d0cbcebe). */
export interface GrokHookPayload {
  hookEventName?: string;
  sessionId?: string;
  lastAssistantMessage?: string;
  reason?: string;
  source?: string;
  stopHookActive?: boolean;
  phase?: string;
  [key: string]: unknown;
}

export type GrokHookResult = "sent" | "skipped" | "failed";

/**
 * Normalize event names from stdin payload and/or GROK_HOOK_EVENT env.
 * Installed grok emits snake_case values: session_start, stop, subagent_stop.
 */
export function normalizeHookEvent(
  payload: GrokHookPayload,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = (payload.hookEventName ?? env.GROK_HOOK_EVENT ?? "").trim();
  if (!raw) return "";
  // Accept PascalCase JSON event names and snake_case runner values.
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Extract a speakable summary when no explicit spoken-completion line is present.
 * Mirrors the Claude Code VoiceCompletion fallback: structured markers first,
 * then a short first sentence.
 */
export function extractFallbackSummary(text: string): string | null {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!cleaned) return null;

  const summaryMatch = cleaned.match(/📋\s*\*{0,2}SUMMARY:?\*{0,2}\s*(.+?)(?:\n|$)/i);
  if (summaryMatch?.[1]) {
    const summary = summaryMatch[1].trim();
    if (summary.length >= 10 && summary.length <= 200) return summary;
  }

  const changeMatch = cleaned.match(/🔧\s*\*{0,2}CHANGE:?\*{0,2}\s*(.+?)(?:\n|$)/i);
  if (changeMatch?.[1]) {
    const change = changeMatch[1].trim();
    if (change.length >= 10 && change.length <= 200) return change;
  }

  // Short free-form last messages (common in headless -p) are speakable as-is.
  if (cleaned.length >= 8 && cleaned.length <= 160 && !cleaned.includes("\n")) {
    return cleaned;
  }

  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const plain = sentence.replace(/[#*_`~>\[\](){}|]/g, "").trim();
    if (plain.length >= 20 && plain.length <= 150 && !/^[═━─╌]/.test(plain)) {
      return /[.!?]$/.test(plain) ? plain : `${plain}.`;
    }
  }

  return null;
}

export function messageFromStop(text: string): string | null {
  const voiceLine = extractVoiceLineFromText(text);
  if (voiceLine) return voiceLine;
  return extractFallbackSummary(text);
}

/** SessionStart sources that mean a brand-new session (not resume/attach). */
function isNewSessionSource(source: string | undefined): boolean {
  const normalized = (source ?? "").trim().toLowerCase();
  // Captured from grok 1.0.0: "new". Docs also mention "startup".
  return normalized === "new" || normalized === "startup" || normalized === "create";
}

export async function handleGrokHookResult(
  payload: GrokHookPayload,
  config: GrokVoiceConfig = loadGrokVoiceConfig(loadEchoEnvironment()),
  env: Record<string, string | undefined> = process.env,
): Promise<GrokHookResult> {
  const event = normalizeHookEvent(payload, env);

  // Never speak subagent stops - a fan-out would produce a storm of lines.
  if (event === "subagent_stop" || event === "subagent_end") return "skipped";

  let message: string | null = null;
  const sessionId = payload.sessionId ?? env.GROK_SESSION_ID;

  if (event === "stop") {
    if (!config.speakCompletions) return "skipped";
    // Gate only genuine turn ends; session-end observe uses reason shutdown/channel_closed.
    if (payload.reason !== "end_turn") return "skipped";
    message = messageFromStop(payload.lastAssistantMessage ?? "");
  } else if (event === "session_start") {
    if (!config.greetOnSessionStart) return "skipped";
    if (!isNewSessionSource(payload.source)) return "skipped";
    message = applyNameToken(pickStartupCatchphrase(config.startupCatchphrases), config.personaName);
  } else {
    return "skipped";
  }

  if (!message) return "skipped";

  try {
    const result = await sendNotification(config, message, "grok", sessionId);
    if (!result.ok) {
      console.error(`[echo/grok] notify failed with HTTP ${result.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error(
      `[echo/grok] notify request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}

export async function handleGrokHook(
  payload: GrokHookPayload,
  config: GrokVoiceConfig = loadGrokVoiceConfig(loadEchoEnvironment()),
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return (await handleGrokHookResult(payload, config, env)) === "sent";
}

async function readStdinJson(): Promise<GrokHookPayload | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GrokHookPayload;
  } catch (error) {
    console.error(
      `[echo/grok] invalid hook JSON on stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

if (import.meta.main) {
  const payload = (await readStdinJson()) ?? {};
  const result = await handleGrokHookResult(payload);
  // Passive hooks: non-zero only for actual notify failures (not skips).
  process.exit(result === "failed" ? 1 : 0);
}
