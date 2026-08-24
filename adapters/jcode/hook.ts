#!/usr/bin/env bun

import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { applyNameToken, pickStartupCatchphrase } from "@echo/shared/greeting.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { extractVoiceLineFromText } from "@echo/shared/voice-line.ts";
import { loadJcodeVoiceConfig, type JcodeVoiceConfig } from "./config.ts";

export interface JcodeHookEnvironment {
  JCODE_HOOK_EVENT?: string;
  JCODE_HOOK_SESSION_ID?: string;
  JCODE_HOOK_SESSION_KIND?: string;
  JCODE_HOOK_PARENT_SESSION_ID?: string;
  JCODE_HOOK_SOURCE?: string;
  JCODE_HOOK_STATUS?: string;
  JCODE_HOOK_LAST_ASSISTANT_TEXT?: string;
}

export type JcodeHookResult = "sent" | "skipped" | "failed";

function isChildSession(env: JcodeHookEnvironment): boolean {
  return Boolean(env.JCODE_HOOK_PARENT_SESSION_ID?.trim())
    || /^(child|subagent|agent)$/i.test(env.JCODE_HOOK_SESSION_KIND?.trim() ?? "");
}

export async function handleJcodeHookResult(
  env: JcodeHookEnvironment & Record<string, string | undefined> = process.env,
  config: JcodeVoiceConfig = loadJcodeVoiceConfig(loadEchoEnvironment()),
): Promise<JcodeHookResult> {
  let message: string | null = null;

  if (isChildSession(env)) return "skipped";

  if (env.JCODE_HOOK_EVENT === "turn_end") {
    if (!config.speakCompletions || env.JCODE_HOOK_STATUS !== "ok") return "skipped";
    message = extractVoiceLineFromText(
      env.JCODE_HOOK_LAST_ASSISTANT_TEXT ?? "",
      [config.personaName],
    );
  } else if (env.JCODE_HOOK_EVENT === "session_start") {
    if (!config.greetOnSessionStart || env.JCODE_HOOK_SOURCE !== "create") return "skipped";
    message = applyNameToken(pickStartupCatchphrase(config.startupCatchphrases), config.personaName);
  }

  if (!message) return "skipped";

  try {
    const result = await sendNotification(config, message, "jcode", env.JCODE_HOOK_SESSION_ID);
    if (!result.ok) {
      console.error(`[echo/jcode] notify failed with HTTP ${result.status}`);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error(`[echo/jcode] notify request failed: ${error instanceof Error ? error.message : String(error)}`);
    return "failed";
  }
}

export async function handleJcodeHook(
  env: JcodeHookEnvironment & Record<string, string | undefined> = process.env,
  config: JcodeVoiceConfig = loadJcodeVoiceConfig(loadEchoEnvironment()),
): Promise<boolean> {
  return (await handleJcodeHookResult(env, config)) === "sent";
}

if (import.meta.main) {
  const result = await handleJcodeHookResult();
  process.exit(result === "failed" ? 1 : 0);
}
