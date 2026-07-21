import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  applyPersonaOverride,
  loadOmpVoiceConfig,
  loadProjectPersona,
  pickStartupCatchphrase,
  shouldSuppressVoice,
  type OmpVoiceConfig,
} from "./config.ts";
import { loadEchoEnvironment } from "../../shared/echo-env.ts";
import { sendNotification } from "../../shared/notify-client.ts";
import { extractVoiceLineFromMessage, stableMessageKey } from "../../shared/voice-line.ts";
import { createEchoVoiceCommand, mergePersonaYaml } from "../../shared/persona-scaffold.ts";

const DEDUPE_WINDOW_MS = 5_000;

function resolveSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId() ?? undefined;
  } catch {
    return undefined;
  }
}

// omp exposes the project root as ctx.cwd (documented ExtensionContext field, pi
// lineage). Read defensively — the installed SDK types may predate it — and treat
// empty as absent.
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

/** Instruction that makes omp's model emit the PAI-style trailing voice line. */
function buildVoiceLineInstruction(personaName: string): string {
  return [
    "## Spoken completion (required)",
    "End EVERY response with a final line, on its own line as the very last line, in exactly this form:",
    `🗣️ ${personaName}: <one sentence, 8-16 words, summarizing what you just did>`,
    "Write plain spoken English in that line — no markdown, no code.",
  ].join("\n");
}

export default function echoVoiceOmpAdapter(
  omp: ExtensionAPI,
  config: OmpVoiceConfig = loadOmpVoiceConfig(loadEchoEnvironment()),
): void {
  const spoken = new Map<string, number>();
  const pending = new Set<string>();

  // Per-project config: layer a persona override from omp's native config
  // (<cwd>/.omp/config.yml over ~/.omp/agent/config.yml, project wins per key —
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

  async function speak(message: string, ctx: ExtensionContext): Promise<boolean> {
    const cfg = resolveConfig(resolveCwd(ctx));
    if (cfg.suppressInSubagents && shouldSuppressVoice({ mode: ctx.mode, hasUI: ctx.hasUI })) return false;
    try {
      const result = await sendNotification(cfg, message, "omp", resolveSessionId(ctx), ctx.signal);
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
    if (!resolveConfig(resolveCwd(ctx)).speakCompletions) return;
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

  // Inject the 🗣️ convention into omp's system prompt so the model emits the
  // spoken line that message_end/turn_end then voices. Gated on the same flags
  // as the speak side so disabled/suppressed contexts neither emit nor speak it.
  omp.on("before_agent_start", (event, ctx) => {
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
    const cfg = resolveConfig(resolveCwd(ctx));
    if (!cfg.greetOnSessionStart) return;
    if (!sessionStartIsUserVisible(event)) return;
    await speak(pickStartupCatchphrase(cfg.startupCatchphrases), ctx);
  });

  omp.on("message_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  omp.on("turn_end", async (event, ctx) => {
    await speakAssistantCompletion(event, ctx);
  });

  omp.on("session_shutdown", () => {
    spoken.clear();
    pending.clear();
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

  // `/echo-voice [name] [voice]` — set THIS repo's persona (name + edge-tts voice)
  // in .omp/config.yml (YAML), merged so other config is preserved. Cross-host analog
  // of the Claude Code `/echo-voice` command; the resolver above reads it next session.
  omp.registerCommand(
    "echo-voice",
    createEchoVoiceCommand({ configPath: [".omp", "config.yml"], merge: mergePersonaYaml }),
  );
}
