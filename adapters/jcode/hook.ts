#!/usr/bin/env bun

import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { applyNameToken } from "@echo/shared/greeting.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { extractVoiceLineFromText } from "@echo/shared/voice-line.ts";
import { loadJcodeVoiceConfig, pickStartupCatchphrase, type JcodeVoiceConfig } from "./config.ts";

export interface JcodeHookEnvironment {
  JCODE_HOOK_EVENT?: string;
  JCODE_HOOK_SESSION_ID?: string;
  JCODE_HOOK_SOURCE?: string;
  JCODE_HOOK_STATUS?: string;
  JCODE_HOOK_LAST_ASSISTANT_TEXT?: string;
}

export async function handleJcodeHook(
  env: JcodeHookEnvironment & Record<string, string | undefined> = process.env,
  config: JcodeVoiceConfig = loadJcodeVoiceConfig(loadEchoEnvironment()),
): Promise<boolean> {
  let message: string | null = null;

  if (env.JCODE_HOOK_EVENT === "turn_end") {
    if (!config.speakCompletions || env.JCODE_HOOK_STATUS !== "ok") return false;
    message = extractVoiceLineFromText(env.JCODE_HOOK_LAST_ASSISTANT_TEXT ?? "");
  } else if (env.JCODE_HOOK_EVENT === "session_start") {
    if (!config.greetOnSessionStart) return false;
    message = applyNameToken(pickStartupCatchphrase(config.startupCatchphrases), config.personaName);
  }

  if (!message) return false;

  try {
    const result = await sendNotification(config, message, "jcode", env.JCODE_HOOK_SESSION_ID);
    if (!result.ok) {
      console.error(`[echo/jcode] notify failed with HTTP ${result.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(`[echo/jcode] notify request failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

if (import.meta.main) {
  await handleJcodeHook();
}
