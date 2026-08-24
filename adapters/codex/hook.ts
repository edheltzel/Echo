#!/usr/bin/env bun

/**
 * Codex lifecycle hook adapter for Echo.
 *
 * Reads Codex Stop / SessionStart JSON from stdin and speaks via Echo using
 * project daidentity from `.codex/settings.json` (same shape as Pi/Claude).
 */

import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { applyNameToken } from "@echo/shared/greeting.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { extractVoiceLineFromText } from "@echo/shared/voice-line.ts";
import {
  loadCodexVoiceConfig,
  pickStartupCatchphrase,
  type CodexVoiceConfig,
} from "./config.ts";

export interface CodexHookPayload {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  // Codex Stop may use these
  reason?: string;
  stop_hook_active?: boolean;
  // Live mode indicator (Codex live transport)
  is_live?: boolean;
  isLive?: boolean;
  [key: string]: unknown;
}

export type CodexHookResult = "sent" | "skipped" | "failed";

export function resolveCodexConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
): CodexVoiceConfig {
  return loadCodexVoiceConfig(loadEchoEnvironment(env), cwd);
}

export function normalizeHookEvent(
  payload: CodexHookPayload,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = (
    payload.hook_event_name
    ?? payload.hookEventName
    ?? env.CODEX_HOOK_EVENT
    ?? env.HOOK_EVENT_NAME
    ?? ""
  ).trim();
  if (!raw) return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function extractFallbackSummary(text: string): string | null {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.length >= 8 && cleaned.length <= 160 && !cleaned.includes("\n")) return cleaned;
  const sentences = cleaned.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const plain = sentence.replace(/[#*_`~>\[\](){}|]/g, "").trim();
    if (plain.length >= 10 && plain.length <= 200) return plain;
  }
  if (cleaned.length > 200) return `${cleaned.slice(0, 197).trimEnd()}...`;
  return cleaned.length >= 10 ? cleaned : null;
}

export function messageFromStop(text: string, personaName?: string): string | null {
  const voice = extractVoiceLineFromText(text, personaName ? [personaName] : undefined);
  if (voice) return voice;
  return extractFallbackSummary(text);
}

function lastAssistantMessage(payload: CodexHookPayload): string {
  return String(payload.last_assistant_message ?? payload.lastAssistantMessage ?? "");
}

function sessionIdOf(payload: CodexHookPayload, env: Record<string, string | undefined>): string | undefined {
  const id = payload.session_id ?? payload.sessionId ?? env.CODEX_SESSION_ID;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function isLiveMode(payload: CodexHookPayload, env: Record<string, string | undefined> = process.env): boolean {
  // Check if Codex live transport indicates live mode
  const isLive = payload.is_live ?? payload.isLive ?? env.CODEX_LIVE ?? false;
  return typeof isLive === "boolean" ? isLive : (typeof isLive === "string" ? ["1", "true", "yes", "on"].includes(isLive.toLowerCase()) : false);
}

export async function handleCodexHookResult(
  payload: CodexHookPayload,
  config: CodexVoiceConfig = resolveCodexConfig(),
  env: Record<string, string | undefined> = process.env,
): Promise<CodexHookResult> {
  const event = normalizeHookEvent(payload, env);

  if (event.includes("subagent")) return "skipped";

  // Suppress voice when in live mode (Codex live transport)
  if (isLiveMode(payload, env)) return "skipped";

  let message: string | null = null;
  const sessionId = sessionIdOf(payload, env);

  if (event === "stop" || event === "stopfailure" || event === "sessionend") {
    if (event === "sessionend") return "skipped";
    if (!config.speakCompletions) return "skipped";
    // When reason is present and not a normal end, skip (mirrors Grok).
    if (payload.reason && payload.reason !== "end_turn" && payload.reason !== "completed") {
      return "skipped";
    }
    message = messageFromStop(lastAssistantMessage(payload), config.personaName);
  } else if (event === "session_start" || event === "sessionstart") {
    if (!config.greetOnSessionStart) return "skipped";
    message = applyNameToken(pickStartupCatchphrase(config.startupCatchphrases), config.personaName);
  } else {
    return "skipped";
  }

  if (!message) return "skipped";

  try {
    const result = await sendNotification(config, message, "codex", sessionId);
    if (!result.ok) {
      console.error(`[echo/codex] notify failed with HTTP ${result.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error(
      `[echo/codex] notify request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}

export async function handleCodexHook(
  payload: CodexHookPayload,
  config: CodexVoiceConfig = resolveCodexConfig(),
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  return (await handleCodexHookResult(payload, config, env)) === "sent";
}

async function readStdinJson(): Promise<CodexHookPayload | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CodexHookPayload;
  } catch (error) {
    console.error(
      `[echo/codex] invalid hook JSON on stdin: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

if (import.meta.main) {
  const payload = (await readStdinJson()) ?? {};
  const result = await handleCodexHookResult(payload);
  process.exit(result === "failed" ? 1 : 0);
}
