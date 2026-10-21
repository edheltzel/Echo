#!/usr/bin/env bun

/**
 * Empryo lifecycle hook adapter for Echo.
 *
 * Empryo runs Claude Code-format hooks from ~/.empryo/hooks.json. This one hook
 * handles SessionStart (greeting), Stop (turn completion, read from Empryo's own
 * session event log) and Notification (approval, question, plan review).
 * Headless runs stay silent, like print mode on the other hosts. Child tabs the
 * agent opened stay silent unless ECHO_VOICE_SUPPRESS_CHILD_TABS=false.
 */

import { readFileSync } from "node:fs";
import { isAutomationSession, loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { startupGreeting } from "@echo/shared/greeting.ts";
import {
  defaultHilDedupeDir,
  formatHilMessage,
  HilDedupe,
  hilDedupeKey,
  type HilKind,
} from "@echo/shared/hil.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import type { NotifySlot } from "@echo/shared/notify-slot.ts";
import { extractVoiceLineFromText } from "@echo/shared/voice-line.ts";
import { loadEmpryoVoiceConfig, type EmpryoVoiceConfig } from "./config.ts";
import { isChildTab, parseEmpryoSessionLog, turnSettled, type EmpryoSessionLog } from "./transcript.ts";

export interface EmpryoHookPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  source?: string;
  notification_type?: string;
  message?: string;
  [key: string]: unknown;
}

export type EmpryoHookResult = "sent" | "skipped" | "failed";

export interface EmpryoHookDeps {
  readFile?: (path: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
  dedupe?: HilDedupe;
  automation?: boolean;
}

/** SessionStart sources Empryo sends for an interactive surface. `headless` never greets. */
const INTERACTIVE_SOURCES = new Set(["desktop", "tui"]);

const HIL_NOTIFICATIONS: Record<string, { kind: HilKind; fallback: string }> = {
  permission_prompt: { kind: "approval", fallback: "a pending request" },
  elicitation_dialog: { kind: "question", fallback: "a question needs your answer" },
  plan_review: { kind: "approval", fallback: "a plan to review" },
};

const SETTLE_ATTEMPTS = 8;
const SETTLE_DELAY_MS = 100;

export function resolveEmpryoConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
): EmpryoVoiceConfig {
  return loadEmpryoVoiceConfig(loadEchoEnvironment(env), cwd);
}

export function extractFallbackSummary(text: string): string | null {
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.length >= 8 && cleaned.length <= 160 && !cleaned.includes("\n")) return cleaned;
  for (const sentence of cleaned.split(/(?<=[.!?])\s+/)) {
    const plain = sentence.replace(/[#*_`~>\[\](){}|]/g, "").trim();
    if (plain.length >= 10 && plain.length <= 200) return plain;
  }
  if (cleaned.length > 200) return `${cleaned.slice(0, 197).trimEnd()}...`;
  return cleaned.length >= 10 ? cleaned : null;
}

export function messageFromStop(text: string, personaName?: string): string | null {
  return extractVoiceLineFromText(text, personaName ? [personaName] : undefined) ?? extractFallbackSummary(text);
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function readSessionLog(
  path: string | undefined,
  deps: EmpryoHookDeps,
  waitForTurn: boolean,
): Promise<EmpryoSessionLog | null> {
  if (!path) return null;
  const readFile = deps.readFile ?? defaultReadFile;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let log: EmpryoSessionLog | null = null;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    const raw = readFile(path);
    if (raw !== null) log = parseEmpryoSessionLog(raw);
    if (!waitForTurn || (log && turnSettled(log))) return log;
    await sleep(SETTLE_DELAY_MS);
  }
  return log;
}

function sessionIdOf(payload: EmpryoHookPayload): string | undefined {
  const id = payload.session_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

async function speak(
  config: EmpryoVoiceConfig,
  message: string,
  sessionId: string | undefined,
  slot: NotifySlot | undefined,
): Promise<EmpryoHookResult> {
  try {
    const result = await sendNotification(config, message, "empryo", sessionId, undefined, undefined, slot);
    if (!result.ok) {
      console.error(`[echo/empryo] notify failed with HTTP ${result.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error(`[echo/empryo] notify request failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

async function handleStop(
  payload: EmpryoHookPayload,
  config: EmpryoVoiceConfig,
  deps: EmpryoHookDeps,
): Promise<EmpryoHookResult> {
  if (!config.speakCompletions) return "skipped";
  const log = await readSessionLog(payload.transcript_path, deps, true);
  if (!log?.lastAssistant || !turnSettled(log)) return "skipped";
  if (log.host === "headless") return "skipped";
  if (config.suppressChildTabs && isChildTab(log, log.lastAssistant.tabId)) return "skipped";
  const message = messageFromStop(log.lastAssistant.text, config.personaName);
  if (!message) return "skipped";
  return speak(config, message, sessionIdOf(payload), "done");
}

async function handleNotification(
  payload: EmpryoHookPayload,
  config: EmpryoVoiceConfig,
  env: Record<string, string | undefined>,
  deps: EmpryoHookDeps,
): Promise<EmpryoHookResult> {
  const spec = HIL_NOTIFICATIONS[payload.notification_type ?? ""];
  if (!spec) return "skipped";
  const log = await readSessionLog(payload.transcript_path, deps, false);
  if (log?.host === "headless") return "skipped";
  if (log && config.suppressChildTabs && isChildTab(log, log.lastTabId)) return "skipped";

  const prompt = typeof payload.message === "string" && payload.message.trim() ? payload.message.trim() : spec.fallback;
  const sessionId = sessionIdOf(payload) ?? "ephemeral";
  const dedupe = deps.dedupe ?? new HilDedupe({ persistDir: defaultHilDedupeDir(env) });
  const key = hilDedupeKey(sessionId, {
    kind: spec.kind,
    prompt,
    requestId: `empryo:${payload.notification_type}:${prompt}`,
  });
  if (!dedupe.tryBegin(key)) return "skipped";
  const message = formatHilMessage({
    kind: spec.kind,
    personaName: config.personaName,
    preferredName: config.preferredName,
    prompt,
  });
  const result = await speak(config, message, sessionIdOf(payload), "request");
  if (result !== "sent") dedupe.release(key);
  return result;
}

export async function handleEmpryoHookResult(
  payload: EmpryoHookPayload,
  config: EmpryoVoiceConfig = resolveEmpryoConfig(),
  env: Record<string, string | undefined> = process.env,
  deps: EmpryoHookDeps = {},
): Promise<EmpryoHookResult> {
  if (config.suppress) return "skipped";
  if (deps.automation ?? isAutomationSession(env, loadEchoEnvironment(env))) return "skipped";

  switch (payload.hook_event_name) {
    case "SessionStart":
      if (!config.greetOnSessionStart || !INTERACTIVE_SOURCES.has(payload.source ?? "")) return "skipped";
      return speak(config, startupGreeting("empryo"), sessionIdOf(payload), undefined);
    case "Stop":
      return handleStop(payload, config, deps);
    case "Notification":
      return handleNotification(payload, config, env, deps);
    default:
      return "skipped";
  }
}

async function readStdinJson(): Promise<EmpryoHookPayload | null> {
  const raw = (await Bun.stdin.text()).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EmpryoHookPayload;
  } catch (error) {
    console.error(`[echo/empryo] invalid hook JSON on stdin: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

if (import.meta.main) {
  const payload = (await readStdinJson()) ?? {};
  const result = await handleEmpryoHookResult(payload, resolveEmpryoConfig(process.env, payload.cwd ?? process.cwd()));
  process.exit(result === "failed" ? 1 : 0);
}
