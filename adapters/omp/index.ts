import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  applyPersonaOverride,
  loadOmpVoiceConfig,
  loadProjectPersona,
  pickStartupCatchphrase,
  shouldSuppressVoice,
  type OmpVoiceConfig,
} from "./config.ts";
import { loadEchoEnvironment } from "@echo/shared/echo-env.ts";
import { sendNotification } from "@echo/shared/notify-client.ts";
import { nativeContextFromAdapterContext } from "@echo/shared/terminal-notify.ts";
import { extractVoiceLineFromMessage, stableMessageKey } from "@echo/shared/voice-line.ts";
import { createEchoVoiceCommand, mergePersonaYaml } from "@echo/shared/persona-scaffold.ts";
import { applyNameToken } from "@echo/shared/greeting.ts";
import { registerEchoAskTool } from "@echo/converse/host-tool.ts";
import { SessionConsent, type SessionConsentDecision } from "@echo/converse/session-consent.ts";

const DEDUPE_WINDOW_MS = 5_000;
const LIVE_DELEGATION_MESSAGE_TYPE = "live-delegation";
// omp emits no live-end signal at all: the live controller stops without putting anything on
// the extension bus. So the mark is released by the next turn that is NOT a live delegation,
// and this cap bounds how long a session can stay silent if no such turn ever arrives. Every
// new delegation refreshes it; suppression must never be unbounded.
const LIVE_MODE_MAX_SILENCE_MS = 10 * 60_000;

type OmpExtensionContext = ExtensionContext & {
  mode?: "tui" | "rpc" | "json" | "print";
  signal?: AbortSignal;
};

function resolveSessionId(ctx: OmpExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined;
  } catch {
    return undefined;
  }
}

// omp exposes the project root as ctx.cwd (documented ExtensionContext field, pi
// lineage). Read defensively - the installed SDK types may predate it - and treat
// empty as absent.
function resolveCwd(ctx: OmpExtensionContext): string | undefined {
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
  console.error(`[echo/omp] ${message}${suffix}`);
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
 * One informed microphone-consent prompt for this omp session's echo_ask calls.
 *
 * No UI means no consent surface: the human never saw a prompt, so the call is
 * "unavailable" (retryable) rather than a sticky denial. The same holds for a
 * cancellation that lands before the prompt is presented. An explicit decline
 * or an abort while the prompt is up is a human signal and stays sticky.
 */
async function promptForAskConsent(ctx: OmpExtensionContext, signal?: AbortSignal): Promise<SessionConsentDecision> {
  if (ctx.hasUI !== true) return "unavailable";
  if (signal?.aborted) return "unavailable";
  try {
    const allowed = await ctx.ui.confirm(
      "Allow Echo voice replies for this omp session?",
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

export default function echoVoiceOmpAdapter(
  omp: ExtensionAPI,
  config: OmpVoiceConfig = loadOmpVoiceConfig(loadEchoEnvironment()),
): void {
  const spoken = new Map<string, number>();
  const pending = new Set<string>();
  const askConsent = new SessionConsent();
  // sessionId -> when the session's most recent live delegation was seen.
  const liveSessionIds = new Map<string, number>();

  function isLiveSession(sessionId: string | undefined, now = Date.now()): boolean {
    if (!sessionId) return false;
    const markedAt = liveSessionIds.get(sessionId);
    if (markedAt === undefined) return false;
    if (now - markedAt <= LIVE_MODE_MAX_SILENCE_MS) return true;
    liveSessionIds.delete(sessionId);
    return false;
  }

  // Per-project config: layer a persona override from omp's native config
  // (<cwd>/.omp/config.yml over ~/.omp/agent/config.yml, project wins per key -
  // same daidentity convention as the Claude Code and Pi adapters) over the
  // env-based `config`, resolved from ctx.cwd and memoized per cwd. A repo with no
  // daidentity resolves to the base config unchanged.
  const configByCwd = new Map<string, OmpVoiceConfig>();
  function resolveConfig(cwd: string | undefined): OmpVoiceConfig {
    const key = cwd ?? "";
    const cached = configByCwd.get(key);
    if (cached) return cached;
    const resolved = applyPersonaOverride(config, loadProjectPersona(key));
    configByCwd.set(key, resolved);
    return resolved;
  }

  function pruneSpoken(now = Date.now()): void {
    for (const [key, spokenAt] of spoken) {
      if (now - spokenAt > DEDUPE_WINDOW_MS) spoken.delete(key);
    }
  }

  async function speak(message: string, ctx: OmpExtensionContext): Promise<boolean> {
    const cfg = resolveConfig(resolveCwd(ctx));
    const sessionId = resolveSessionId(ctx);
    if (cfg.suppressInSubagents && shouldSuppressVoice({ mode: ctx.mode, hasUI: ctx.hasUI })) return false;
    // Suppress the notification while this session is in live mode. This is the ONLY
    // suppression point: the voice-line instruction still goes into the system prompt, so the
    // first turn after live mode ends still carries the 🗣️ line it needs to be spoken.
    if (isLiveSession(sessionId)) return false;
    try {
      const result = await sendNotification(
        cfg,
        message,
        "omp",
        sessionId,
        ctx.signal,
        nativeContextFromAdapterContext(ctx, process.env, sessionId, ctx.hasUI === true),
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

  async function speakAssistantCompletion(event: unknown, ctx: OmpExtensionContext): Promise<void> {
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

  // Inject the 🗣️ convention into omp's system prompt so the model emits the
  // spoken line that message_end/turn_end then voices. Gated on the same config
  // flags as the speak side so disabled/suppressed contexts neither emit nor speak it.
  // Live mode deliberately does NOT gate here: it suppresses the notification only
  // (see speak()), and this handler runs before the message_start that would release
  // the mark, so gating it would read a stale flag.
  const onBeforeAgentStart = omp.on.bind(omp) as unknown as (
    event: "before_agent_start",
    handler: (event: unknown, ctx: OmpExtensionContext) => unknown,
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
    return {
      systemPrompt: `${base}\n\n${instruction}`,
      systemPromptAppend: `\n\n${instruction}`,
    };
  });

  omp.on("session_start", async (event, ctx) => {
    askConsent.begin(resolveSessionId(ctx));
    const cfg = resolveConfig(resolveCwd(ctx));
    if (!cfg.greetOnSessionStart) return;
    if (!sessionStartIsUserVisible(event)) return;
    await speak(applyNameToken(pickStartupCatchphrase(cfg.startupCatchphrases), cfg.personaName, cfg.sayName), ctx);
  });

  omp.on("message_start", (event, ctx) => {
    const sessionId = resolveSessionId(ctx);
    const message = eventMessage(event);
    if (!sessionId || typeof message !== "object" || message === null) return;
    const role = "role" in message ? (message as { role?: unknown }).role : undefined;
    const customType = "customType" in message ? (message as { customType?: unknown }).customType : undefined;
    if (role === "custom" && customType === LIVE_DELEGATION_MESSAGE_TYPE) {
      liveSessionIds.set(sessionId, Date.now());
    } else if (role === "user" || role === "custom") {
      // Any other turn-triggering message ends live mode. Typed user messages are not the only
      // way a turn starts - prewalk, advisor and session-stop continuations all drive turns with
      // `role: "custom"` - so releasing only on `role: "user"` leaves agent-driven turns silent.
      // Assistant/tool messages are deliberately excluded: they occur INSIDE a live delegation's
      // own turn and would release the mark immediately.
      liveSessionIds.delete(sessionId);
    }
  });

  omp.on("message_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  omp.on("turn_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  omp.on("session_shutdown", (event, ctx: OmpExtensionContext | undefined) => {
    askConsent.end();
    spoken.clear();
    pending.clear();
    // Clean up live mode tracking for this session
    if (ctx) {
      const sessionId = resolveSessionId(ctx);
      if (sessionId) liveSessionIds.delete(sessionId);
    }
  });

  omp.registerCommand("voice-status", {
    description: "Show echo omp adapter status",
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

  // `echo_ask` - the model-invocable two-way turn, identical to the Pi adapter's
  // (both share @echo/converse/host-tool.ts, so the two hosts cannot drift into
  // different tools). The capture child is spawned from THIS process so macOS
  // attributes the microphone grant to the host terminal (docs/converse.md).
  registerEchoAskTool(omp, {
    source: "omp",
    // omp's live conversation already holds the microphone, so a spoken ask would put two
    // consumers on one device and speak over live audio. Fail soft as unavailable: the model
    // learns it must ask in text, and nothing opens the microphone.
    unavailableReason: (ctx) =>
      isLiveSession(resolveSessionId(ctx as OmpExtensionContext))
        ? "echo_ask is unavailable while this omp session is in live mode - the live conversation owns the microphone. Ask in text instead."
        : undefined,
    ensureConsent: (ctx, signal) => {
      const extensionContext = ctx as OmpExtensionContext;
      return askConsent.ensure(resolveSessionId(extensionContext), () => promptForAskConsent(extensionContext, signal));
    },
    resolveVoice: (ctx) => {
      const cfg = resolveConfig(resolveCwd(ctx as OmpExtensionContext));
      return { voiceId: cfg.voiceId, title: cfg.title };
    },
  });

  // `/echo-voice [name] [voice]` - set THIS repo's persona (name + edge-tts voice)
  // in .omp/config.yml (YAML), merged so other config is preserved. Cross-host analog
  // of the Claude Code `/echo-voice` command; the resolver above reads it next session.
  omp.registerCommand(
    "echo-voice",
    createEchoVoiceCommand({ configPath: [".omp", "config.yml"], merge: mergePersonaYaml }),
  );
}
