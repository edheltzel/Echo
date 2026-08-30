import { applyNameToken } from "@echo/shared/greeting.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { extractVoiceLineFromText, stableMessageKey } from "@echo/shared/voice-line.ts";
import { loadOpenCodeVoiceConfig, pickStartupCatchphrase, type OpenCodeVoiceConfig } from "./config.ts";

export type OpenCodeHookResult = "sent" | "skipped" | "failed";

export interface OpenCodeSessionSnapshot {
  id: string;
  parentID?: string;
  title?: string;
  agent?: string;
}

export interface OpenCodeSessionPort {
  getSession(id: string): Promise<OpenCodeSessionSnapshot | null>;
  lastAssistantText(id: string): Promise<string>;
}

export interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  properties?: {
    sessionID?: string;
    info?: {
      id?: string;
      parentID?: string;
      title?: string;
      agent?: string;
    };
  };
  info?: {
    id?: string;
    parentID?: string;
    title?: string;
    agent?: string;
  };
  [key: string]: unknown;
}

const spokenKeys = new Set<string>();

export function resetSpokenKeys(): void {
  spokenKeys.clear();
}

export function eventType(event: OpenCodeEvent): string {
  return typeof event.type === "string" ? event.type : "";
}

export function eventSessionID(event: OpenCodeEvent): string | undefined {
  if (typeof event.sessionID === "string" && event.sessionID) return event.sessionID;
  const props = event.properties;
  if (typeof props?.sessionID === "string" && props.sessionID) return props.sessionID;
  if (typeof props?.info?.id === "string" && props.info.id) return props.info.id;
  if (typeof event.info?.id === "string" && event.info.id) return event.info.id;
  return undefined;
}

function eventSessionHint(event: OpenCodeEvent): OpenCodeSessionSnapshot | null {
  const info = event.properties?.info ?? event.info;
  if (!info?.id) return null;
  return {
    id: info.id,
    parentID: info.parentID,
    title: info.title,
    agent: info.agent,
  };
}

export function extractFallbackSummary(text: string): string | null {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (!cleaned) return null;

  const summaryMatch = cleaned.match(/📋\s*\*{0,2}SUMMARY:?\*{0,2}\s*(.+?)(?:\n|$)/i);
  if (summaryMatch?.[1]) {
    const summary = summaryMatch[1].trim();
    if (summary.length >= 10 && summary.length <= 200) return summary;
  }

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

export function messageFromAssistantText(text: string, personaName?: string): string | null {
  const voiceLine = extractVoiceLineFromText(text, personaName ? [personaName] : undefined);
  if (voiceLine) return voiceLine;
  return extractFallbackSummary(text);
}

export function lastAssistantTextFromMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const info = (record.info && typeof record.info === "object")
      ? record.info as Record<string, unknown>
      : record;
    const role = info.role ?? info.type;
    if (role !== "assistant") continue;

    const texts: string[] = [];
    const parts = record.parts ?? info.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if ((p.type === "text" || p.type === undefined) && typeof p.text === "string") {
          texts.push(p.text);
        }
      }
    }
    if (typeof info.content === "string") texts.push(info.content);
    if (typeof record.content === "string") texts.push(record.content);
    const joined = texts.join("\n").trim();
    if (joined) return joined;
  }
  return "";
}

export async function handleOpenCodeEvent(
  event: OpenCodeEvent,
  config: OpenCodeVoiceConfig = loadOpenCodeVoiceConfig(),
  port?: OpenCodeSessionPort,
): Promise<OpenCodeHookResult> {
  const type = eventType(event);
  const sessionID = eventSessionID(event);
  if (!sessionID) return "skipped";

  let session = eventSessionHint(event);
  if (port) {
    session = await port.getSession(sessionID);
    if (session === null) return "skipped";
  } else if (session === null) {
    return "skipped";
  }
  if (session.parentID) return "skipped";

  let message: string | null = null;
  let subject: unknown = event;

  if (type === "session.created") {
    if (!config.greetOnSessionStart) return "skipped";
    message = applyNameToken(
      pickStartupCatchphrase(config.startupCatchphrases),
      config.personaName,
      config.sayName,
    );
    subject = { id: `created:${sessionID}` };
  } else if (type === "session.idle") {
    if (!config.speakCompletions) return "skipped";
    const text = port ? await port.lastAssistantText(sessionID) : "";
    message = messageFromAssistantText(text, config.personaName);
    subject = { text };
  } else {
    return "skipped";
  }

  if (!message) return "skipped";

  const key = stableMessageKey(sessionID, subject, message);
  if (spokenKeys.has(key)) return "skipped";

  try {
    const result = await sendNotification(config, message, "opencode", sessionID);
    if (!result.ok) {
      console.error(`[echo/opencode] notify failed with HTTP ${result.status}`);
      return "failed";
    }
    spokenKeys.add(key);
    return "sent";
  } catch (error) {
    console.error(
      `[echo/opencode] notify request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "failed";
  }
}
