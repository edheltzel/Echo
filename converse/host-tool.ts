// The model-invokable ask tool, shared by every host that can register one.
//
// Each host adapter contributes only its own registration call; the tool's name,
// schema, description and behavior live here so Pi, omp and the MCP server
// cannot drift into three subtly different tools.
//
// The schema is plain JSON Schema on purpose. Both Pi runtimes accept a tool's
// `parameters` as Zod, ArkType or JSON Schema, and the JSON branch needs no
// schema library and no host SDK import - which keeps this module host-neutral
// and the adapters dependency-free.

import { askOnce, AskError, type AskOptions, type AskResult } from "./client.ts";
import type { SessionConsentDecision } from "./session-consent.ts";

export const ECHO_ASK_TOOL_NAME = "echo_ask";

export const ECHO_ASK_TOOL_LABEL = "Echo Ask";

export const ECHO_ASK_TOOL_DESCRIPTION = [
  "Ask the human a question out loud and wait for their spoken answer.",
  "Echo speaks the question through the local voice daemon, records the reply from the",
  "microphone, transcribes it on-device and returns the transcript.",
  "Use this when the human is away from the keyboard, or when a short spoken answer is",
  "faster than waiting for typing. Ask one short question at a time.",
  "The call blocks until the human stops speaking, and only one ask can hold the",
  "microphone at a time.",
].join(" ");

/** JSON Schema, accepted directly by the Pi and omp tool runtimes. */
export const ECHO_ASK_PARAMETERS = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to speak aloud. One sentence, phrased for the ear rather than the eye.",
    },
  },
  required: ["question"],
  additionalProperties: false,
} as const;

export interface AskToolOutcome {
  /** What the host hands back to the model. */
  text: string;
  isError: boolean;
  details: Record<string, unknown>;
}

export interface AskToolOptions {
  source: string;
  voiceId?: string;
  title?: string;
  signal?: AbortSignal;
  /** Must return granted before this call may reach the microphone. */
  ensureConsent?: () => Promise<SessionConsentDecision>;
  /** Injected in tests; the real one runs a full turn. */
  ask?: (options: AskOptions) => Promise<AskResult>;
}

/** The one host capability this needs. Optional, because older runtimes lack it. */
export interface ToolRegisteringHost {
  // Host SDKs expose incompatible generic ToolDefinition signatures. Registration
  // is feature-detected, then narrowed to the shared JSON definition below.
  registerTool?: unknown;
}

export interface AskToolHostOptions {
  source: string;
  /**
   * Resolved per call, not once at registration: the persona voice can differ
   * per project, and the host only knows which project a call belongs to when
   * the call arrives.
   */
  resolveVoice?: (ctx: unknown) => { voiceId?: string; title?: string };
  /** Resolve or request the one consent decision for this live host session. */
  ensureConsent?: (ctx: unknown, signal?: AbortSignal) => Promise<SessionConsentDecision>;
  ask?: AskToolOptions["ask"];
}

/**
 * Register `echo_ask` on a host that can expose model-invokable tools.
 *
 * Returns false when the host cannot register tools. A runtime older than the
 * tool API must keep working: the adapter's whole notification path would go
 * down with the extension if this threw, so an absent capability costs the ask
 * tool and nothing else.
 */
export function registerEchoAskTool(host: ToolRegisteringHost, options: AskToolHostOptions): boolean {
  if (typeof host.registerTool !== "function") return false;
  const registerTool = host.registerTool.bind(host) as (definition: Record<string, unknown>) => void;

  registerTool({
    name: ECHO_ASK_TOOL_NAME,
    label: ECHO_ASK_TOOL_LABEL,
    description: ECHO_ASK_TOOL_DESCRIPTION,
    parameters: ECHO_ASK_PARAMETERS,
    // Keep the host's generic tool gate read-tier so it does not prompt on every
    // call. Echo performs its own informed microphone prompt once per session.
    approval: "read",
    // Argument order per the extension tool wrapper, which passes
    // (toolCallId, params, signal, onUpdate, ctx). The file-based CustomTool API
    // uses a different order; this is deliberately not that API.
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: unknown,
    ) => {
      const voice = options.resolveVoice?.(ctx) ?? {};
      const ensureConsent = options.ensureConsent;
      const outcome = await runAskTool(params, {
        source: options.source,
        voiceId: voice.voiceId,
        title: voice.title,
        signal,
        ensureConsent: ensureConsent
          ? () => ensureConsent(ctx, signal)
          : undefined,
        ask: options.ask,
      });
      return {
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
        details: outcome.details,
      };
    },
  });
  return true;
}

function readQuestion(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const question = (params as { question?: unknown }).question;
  return typeof question === "string" && question.trim().length > 0 ? question.trim() : null;
}

/**
 * Run one ask on behalf of a host's tool call.
 *
 * Failures come back as tool text rather than thrown errors: the model asked a
 * question and needs to learn that nobody answered, which is a fact about the
 * conversation, not a host-session crash.
 */
export async function runAskTool(params: unknown, options: AskToolOptions): Promise<AskToolOutcome> {
  const question = readQuestion(params);
  if (question === null) {
    return {
      text: "echo_ask needs a non-empty `question` string.",
      isError: true,
      details: { error: "invalid_request" },
    };
  }

  const consent = await options.ensureConsent?.() ?? "unavailable";
  if (consent !== "granted") {
    const denied = consent === "denied";
    return {
      text: denied
        ? "echo_ask did not open the microphone because consent was denied for this host session."
        : "echo_ask cannot open the microphone without consent from a live host session.",
      isError: true,
      details: { error: denied ? "session_consent_denied" : "session_consent_required" },
    };
  }

  const ask = options.ask ?? ((askOptions: AskOptions) => askOnce(askOptions));
  try {
    const result = await ask({
      question,
      source: options.source,
      voiceId: options.voiceId,
      title: options.title,
      signal: options.signal,
    });
    return {
      text: result.text,
      isError: false,
      details: {
        turn_id: result.turn_id,
        engine: result.engine,
        capture_ms: result.capture_ms,
        // Evidence that the microphone was opened inside this host's own process
        // tree, which is what makes the macOS grant attribute to the terminal.
        ancestry: result.ancestry,
      },
    };
  } catch (error) {
    const code = error instanceof AskError ? error.code : "ask_failed";
    const detail = error instanceof Error ? error.message : String(error);
    return {
      text: `No spoken reply was captured (${code}): ${detail}`,
      isError: true,
      details: { error: code },
    };
  }
}
