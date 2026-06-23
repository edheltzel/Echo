import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiVoiceConfig, shouldSuppressVoice } from "./config.ts";
import { sendPiNotification } from "./notify-client.ts";
import { extractVoiceLineFromMessage, stableMessageKey } from "./voice-line.ts";

const DEDUPE_WINDOW_MS = 5_000;

function resolveSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined;
  } catch {
    return undefined;
  }
}

function sessionStartIsUserVisible(event: unknown): boolean {
  const reason = typeof event === "object" && event !== null && "reason" in event
    ? String((event as { reason?: unknown }).reason ?? "")
    : "";
  return reason !== "reload";
}

function logAdapterWarning(message: string, error?: unknown): void {
  const suffix = error ? `: ${error instanceof Error ? error.message : String(error)}` : "";
  console.error(`[atlas-voicesystem/pi] ${message}${suffix}`);
}

function eventMessage(event: unknown): unknown {
  return typeof event === "object" && event !== null && "message" in event
    ? (event as { message?: unknown }).message
    : undefined;
}

function readSystemPrompt(event: unknown): string | undefined {
  if (typeof event === "object" && event !== null && "systemPrompt" in event) {
    const value = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Instruction that makes Pi's model emit the PAI-style trailing voice line. */
function buildVoiceLineInstruction(personaName: string): string {
  return [
    "## Spoken completion (required)",
    "End EVERY response with a final line, on its own line as the very last line, in exactly this form:",
    `🗣️ ${personaName}: <one sentence, 8-16 words, summarizing what you just did>`,
    "Write plain spoken English in that line — no markdown, no code.",
  ].join("\n");
}

export default function atlasVoicePiAdapter(pi: ExtensionAPI): void {
  const config = loadPiVoiceConfig();
  const spoken = new Map<string, number>();
  const pending = new Set<string>();

  function pruneSpoken(now = Date.now()): void {
    for (const [key, spokenAt] of spoken) {
      if (now - spokenAt > DEDUPE_WINDOW_MS) spoken.delete(key);
    }
  }

  async function speak(message: string, ctx: ExtensionContext): Promise<boolean> {
    if (config.suppressInSubagents && shouldSuppressVoice({ mode: ctx.mode, hasUI: ctx.hasUI })) return false;
    try {
      const result = await sendPiNotification(config, message, resolveSessionId(ctx), ctx.signal);
      if (!result.ok) {
        logAdapterWarning(`notify failed with HTTP ${result.status}`);
        return false;
      }
      return true;
    } catch (error) {
      logAdapterWarning("notify request failed", error);
      return false;
    }
  }

  async function speakAssistantCompletion(event: unknown, ctx: ExtensionContext): Promise<void> {
    if (!config.speakCompletions) return;
    const message = eventMessage(event);
    const line = extractVoiceLineFromMessage(message);
    if (!line) return;

    const sessionId = resolveSessionId(ctx) ?? "ephemeral";
    const now = Date.now();
    pruneSpoken(now);

    const key = stableMessageKey(sessionId, event, line);
    if (pending.has(key) || spoken.has(key)) return;
    pending.add(key);

    try {
      if (await speak(line, ctx)) {
        spoken.set(key, Date.now());
      }
    } finally {
      pending.delete(key);
    }
  }

  // Inject the 🗣️ convention into Pi's system prompt so the model emits the
  // spoken line that message_end/turn_end then voices. Gated on the same flags
  // as the speak side so disabled/suppressed contexts neither emit nor speak it.
  pi.on("before_agent_start", (event, ctx) => {
    if (!config.speakCompletions) return undefined;
    if (config.suppressInSubagents && shouldSuppressVoice({ mode: ctx.mode, hasUI: ctx.hasUI })) {
      return undefined;
    }

    const base = readSystemPrompt(event);
    if (base === undefined) return undefined; // feature-detect: older runtime → safe no-op

    const instruction = buildVoiceLineInstruction(config.personaName);
    // Always APPEND to the chained prompt (never clobber other extensions).
    // `systemPrompt` is the documented replace return; `systemPromptAppend`
    // is the fallback for runtimes that ignore the replace return.
    return {
      systemPrompt: `${base}\n\n${instruction}`,
      systemPromptAppend: `\n\n${instruction}`,
    };
  });

  pi.on("session_start", async (event, ctx) => {
    if (!config.greetOnSessionStart) return;
    if (!sessionStartIsUserVisible(event)) return;
    await speak(config.catchphrase, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  pi.on("session_shutdown", () => {
    spoken.clear();
    pending.clear();
  });

  pi.registerCommand("voice-status", {
    description: "Show atlas-voicesystem Pi adapter status",
    handler: async (_args, ctx) => {
      const state = [
        `endpoint: ${config.endpoint}`,
        `voice: ${config.voiceEnabled ? "enabled" : "silent"}`,
        `greeting: ${config.greetOnSessionStart ? "enabled" : "disabled"}`,
        `completions: ${config.speakCompletions ? "enabled" : "disabled"}`,
        `subagent suppression: ${config.suppressInSubagents ? "enabled" : "disabled"}`,
      ].join("\n");
      ctx.ui.notify(state, "info");
    },
  });
}
