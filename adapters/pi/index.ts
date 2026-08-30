import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyPersonaOverride,
  loadPiVoiceConfig,
  loadProjectPersona,
  pickStartupCatchphrase,
  shouldSuppressVoice,
  type EchoPersonaOverride,
  type PiVoiceConfig,
} from "./config.ts";
import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { nativeContextFromAdapterContext } from "@echo/shared/terminal-notify.ts";
import { extractVoiceLineFromMessage, stableMessageKey } from "@echo/shared/voice-line.ts";
import { createEchoMuteCommand } from "@echo/shared/mute-command.ts";
import { createEchoVoiceCommand, mergePersonaJson } from "@echo/shared/persona-scaffold.ts";
import { applyNameToken } from "@echo/shared/greeting.ts";
import { registerEchoAskTool } from "@echo/converse/host-tool.ts";
import { SessionConsent, type SessionConsentDecision } from "@echo/converse/session-consent.ts";

const DEDUPE_WINDOW_MS = 5_000;

function resolveSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined;
  } catch {
    return undefined;
  }
}

// Pi exposes the project root as ctx.cwd (documented ExtensionContext field). Read
// defensively - the installed SDK types may predate it - and treat empty as absent.
function resolveCwd(ctx: ExtensionContext): string | undefined {
  const cwd = (ctx as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

function sessionStartIsUserVisible(event: unknown): boolean {
  const reason = typeof event === "object" && event !== null && "reason" in event
    ? String((event as { reason?: unknown }).reason ?? "")
    : "";
  return reason !== "reload";
}

function logAdapterWarning(message: string, error?: unknown): void {
  const suffix = error ? `: ${error instanceof Error ? error.message : String(error)}` : "";
  console.error(`[echo/pi] ${message}${suffix}`);
}

function eventMessage(event: unknown): unknown {
  return typeof event === "object" && event !== null && "message" in event
    ? (event as { message?: unknown }).message
    : undefined;
}

function readSystemPrompt(event: unknown): string | string[] | undefined {
  if (typeof event === "object" && event !== null && "systemPrompt" in event) {
    const value = (event as { systemPrompt?: unknown }).systemPrompt;
    if (typeof value === "string") return value;
    // oh-my-pi passes systemPrompt as string[] (upstream Pi uses string).
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      return value as string[];
    }
  }
  return undefined;
}

/**
 * One informed microphone-consent prompt for this Pi session's echo_ask calls.
 *
 * No UI means no consent surface: the human never saw a prompt, so the call is
 * "unavailable" (retryable) rather than a sticky denial. The same holds for a
 * cancellation that lands before the prompt is presented. An explicit decline
 * or an abort while the prompt is up is a human signal and stays sticky.
 */
async function promptForAskConsent(ctx: ExtensionContext, signal?: AbortSignal): Promise<SessionConsentDecision> {
  if (ctx.hasUI !== true) return "unavailable";
  if (signal?.aborted) return "unavailable";
  try {
    const allowed = await ctx.ui.confirm(
      "Allow Echo voice replies for this Pi session?",
      "Echo will record and transcribe microphone audio whenever echo_ask runs in this session. " +
        "You will not be prompted again until this session ends.",
      signal ? { signal } : undefined,
    );
    return allowed ? "granted" : "denied";
  } catch {
    return signal?.aborted ? "denied" : "unavailable";
  }
}

function buildVoiceLineInstruction(personaName: string): string {
  return [
    "## Spoken completion (required)",
    "End EVERY response with a final line, on its own line as the very last line, in exactly this form:",
    `🗣️ ${personaName}: <one sentence, 8-16 words, summarizing what you just did>`,
    "Write plain spoken English in that line - no markdown, no code.",
  ].join("\n");
}

export default function atlasVoicePiAdapter(
  pi: ExtensionAPI,
  config: PiVoiceConfig = loadPiVoiceConfig(loadEchoEnvironment()),
  loadPersona: (cwd: string | undefined) => EchoPersonaOverride | null = loadProjectPersona,
): void {
  const spoken = new Map<string, number>();
  const pending = new Set<string>();
  const askConsent = new SessionConsent();

  // Per-project config: layer a persona override from Pi's native settings.json
  // (<cwd>/.pi/settings.json over ~/.pi/agent/settings.json, project wins per key -
  // same daidentity convention as the Claude Code adapter) over the env-based
  // `config`, resolved from ctx.cwd and memoized per cwd. A repo with no daidentity
  // - and every omp session, since .pi/ isn't omp's dir - resolves to the base
  // config unchanged. omp's own .omp reader lands with the #109 adapter split.
  // Tests inject `loadPersona` so operator ~/.pi never overlays configured greetings.
  const configByCwd = new Map<string, PiVoiceConfig>();
  function resolveConfig(cwd: string | undefined): PiVoiceConfig {
    const key = cwd ?? "";
    const cached = configByCwd.get(key);
    if (cached) return cached;
    const resolved = applyPersonaOverride(config, loadPersona(key || undefined));
    configByCwd.set(key, resolved);
    return resolved;
  }

  function pruneSpoken(now = Date.now()): void {
    for (const [key, spokenAt] of spoken) {
      if (now - spokenAt > DEDUPE_WINDOW_MS) spoken.delete(key);
    }
  }

  async function speak(message: string, ctx: ExtensionContext): Promise<boolean> {
    const cfg = resolveConfig(resolveCwd(ctx));
    if (cfg.suppressInSubagents && shouldSuppressVoice({ mode: ctx.mode, hasUI: ctx.hasUI })) return false;
    try {
      const result = await sendNotification(
        cfg,
        message,
        "pi",
        resolveSessionId(ctx),
        ctx.signal,
        nativeContextFromAdapterContext(ctx, process.env, resolveSessionId(ctx), ctx.hasUI === true),
      );
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
    const cfg = resolveConfig(resolveCwd(ctx));
    if (!cfg.speakCompletions) return;
    const message = eventMessage(event);
    const line = extractVoiceLineFromMessage(message, [cfg.personaName]);
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
  const onBeforeAgentStart = pi.on.bind(pi) as unknown as (
    event: "before_agent_start",
    handler: (event: unknown, ctx: ExtensionContext) => unknown,
  ) => void;
  onBeforeAgentStart("before_agent_start", (event, ctx) => {
    const cfg = resolveConfig(resolveCwd(ctx));
    if (!cfg.speakCompletions) return undefined;
    if (cfg.suppressInSubagents && shouldSuppressVoice({ mode: ctx.mode, hasUI: ctx.hasUI })) {
      return undefined;
    }

    const base = readSystemPrompt(event);
    if (base === undefined) return undefined; // feature-detect: unknown shape → safe no-op

    const instruction = buildVoiceLineInstruction(cfg.personaName);
    // Always APPEND to the chained prompt (never clobber other extensions),
    // returning the same shape the host passed in.
    if (Array.isArray(base)) {
      // oh-my-pi: systemPrompt is string[] in and string[] out.
      return { systemPrompt: [...base, instruction] };
    }
    // Upstream Pi: `systemPrompt` is the documented replace return;
    // `systemPromptAppend` is the fallback for runtimes that ignore it.
    return {
      systemPrompt: `${base}\n\n${instruction}`,
      systemPromptAppend: `\n\n${instruction}`,
    };
  });

  pi.on("session_start", async (event, ctx) => {
    askConsent.begin(resolveSessionId(ctx));
    const cfg = resolveConfig(resolveCwd(ctx));
    if (!cfg.greetOnSessionStart) return;
    if (!sessionStartIsUserVisible(event)) return;
    await speak(applyNameToken(pickStartupCatchphrase(cfg.startupCatchphrases), cfg.personaName, cfg.sayName), ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  pi.on("session_shutdown", () => {
    askConsent.end();
    spoken.clear();
    pending.clear();
  });

  pi.registerCommand("voice-status", {
    description: "Show echo Pi adapter status",
    handler: async (_args, ctx) => {
      const cfg = resolveConfig(resolveCwd(ctx));
      const state = [
        `persona: ${cfg.personaName}`,
        `voice_id: ${cfg.voiceId ?? "(default)"}`,
        `endpoint: ${cfg.endpoint}`,
        `voice: ${cfg.voiceEnabled ? "enabled" : "silent"}`,
        `greeting: ${cfg.greetOnSessionStart ? "enabled" : "disabled"}`,
        `completions: ${cfg.speakCompletions ? "enabled" : "disabled"}`,
        `subagent suppression: ${cfg.suppressInSubagents ? "enabled" : "disabled"}`,
      ].join("\n");
      ctx.ui.notify(state, "info");
    },
  });

  // `echo_ask` - the model-invocable two-way turn: speak a question, capture the
  // spoken reply, return the transcript. A tool, not a command: a command is
  // human-initiated, and this has to be something the model itself can decide to
  // call mid-turn. The capture child is spawned from THIS process, which is what
  // makes macOS attribute the microphone grant to the host terminal rather than
  // to a background service (docs/converse.md).
  registerEchoAskTool(pi, {
    source: "pi",
    ensureConsent: (ctx, signal) => {
      const extensionContext = ctx as ExtensionContext;
      return askConsent.ensure(resolveSessionId(extensionContext), () => promptForAskConsent(extensionContext, signal));
    },
    resolveVoice: (ctx) => {
      const cfg = resolveConfig(resolveCwd(ctx as ExtensionContext));
      return { voiceId: cfg.voiceId, title: cfg.title };
    },
  });

  // `/echo-voice [name] [voice]` - set THIS repo's persona (name + edge-tts voice)
  // in .pi/settings.json, merged so other settings are preserved. Cross-host analog
  // of the Claude Code `/echo-voice` command; the resolver above reads it next session.
  pi.registerCommand(
    "echo-voice",
    createEchoVoiceCommand({ configPath: [".pi", "settings.json"], merge: mergePersonaJson }),
  );
  pi.registerCommand("echo-mute", createEchoMuteCommand());
}
