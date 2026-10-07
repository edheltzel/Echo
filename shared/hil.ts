// Host-neutral needs-input / approval / attention announce (#107).
// Adapters detect host events; this module owns wording, preferred-name, and
// one-announce-per-request dedupe. Core stays out of it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EchoEnvironment } from "./echo-env.ts";

export const HIL_KINDS = ["question", "approval", "attention"] as const;
export type HilKind = (typeof HIL_KINDS)[number];

export const HIL_PROMPT_MAX_CHARS = 140;
export const HIL_DEDUPE_TTL_MS = 15 * 60_000;

const ECHO_CONSENT_TITLE = /allow echo voice replies/i;

export interface HilCandidate {
  kind: HilKind;
  prompt: string;
  requestId: string;
}

export interface HilAnnounce {
  kind: HilKind;
  personaName: string;
  preferredName?: string;
  prompt?: string;
}

const FALLBACK: Record<HilKind, string> = {
  question: "a question needs your answer",
  approval: "a pending request",
  attention: "the session is waiting",
};

/** Configured human name, or undefined. Never invents a name. */
export function preferredHumanName(env: EchoEnvironment = {}): string | undefined {
  const raw = env.ECHO_PREFERRED_NAME;
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  return name.length > 0 ? name : undefined;
}

export function clipHilPrompt(text: string, max = HIL_PROMPT_MAX_CHARS): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function formatHilMessage(announce: HilAnnounce): string {
  const prompt = clipHilPrompt(announce.prompt ?? "") || FALLBACK[announce.kind];
  const persona = announce.personaName.trim() || "the agent";
  let body: string;
  if (announce.kind === "question") body = prompt;
  else if (announce.kind === "approval") body = `${persona} needs approval: ${prompt}`;
  else body = `${persona} is paused and needs your attention: ${prompt}`;
  const name = announce.preferredName?.trim();
  const addressed = name ? `${name}, ${body}` : body;
  return clipHilPrompt(addressed, 220);
}

export function hilDedupeKey(sessionId: string, candidate: HilCandidate): string {
  return `${sessionId}:${candidate.requestId}`;
}

function requestId(kind: HilKind, ...parts: Array<string | undefined>): string {
  const rest = parts.map((part) => clipHilPrompt(part ?? "", 80).toLowerCase()).filter(Boolean);
  return [kind, ...rest].join(":");
}

export function promptFromAskUserQuestionInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const questions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const first = questions[0];
  if (!first || typeof first !== "object") return undefined;
  const question = (first as { question?: unknown }).question;
  if (typeof question === "string" && question.trim()) return question.trim();
  const header = (first as { header?: unknown }).header;
  if (typeof header === "string" && header.trim()) return header.trim();
  return undefined;
}

export function promptFromToolInput(toolName: string, input: unknown): string | undefined {
  if (toolName === "AskUserQuestion") return promptFromAskUserQuestionInput(input);
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ["description", "command", "plan", "file_path", "path", "prompt"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Classify Pi/omp extension events. Unknown shapes and Echo's own consent
 * prompt return null. Hosts that lack an event simply never emit it.
 */
export function classifyExtensionHil(event: unknown, eventName?: string): HilCandidate | null {
  const record = typeof event === "object" && event !== null ? event as Record<string, unknown> : {};
  const type = typeof record.type === "string" ? record.type : eventName;

  if (type === "tool_approval_requested") {
    const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
    const reason = typeof record.reason === "string" ? record.reason : undefined;
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : toolName;
    return {
      kind: "approval",
      prompt: reason?.trim() || toolName,
      requestId: requestId("approval", toolCallId, toolName),
    };
  }

  if (type === "ui_prompt_start") {
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (ECHO_CONSENT_TITLE.test(title)) return null;
    const kindName = typeof record.kind === "string" ? record.kind : "";
    const prompt = title || undefined;
    if (kindName === "confirm") {
      return {
        kind: "approval",
        prompt: prompt ?? FALLBACK.approval,
        requestId: requestId("approval", title || "confirm"),
      };
    }
    if (kindName === "custom") {
      return {
        kind: "attention",
        prompt: prompt ?? FALLBACK.attention,
        requestId: requestId("attention", title || "custom"),
      };
    }
    return {
      kind: "question",
      prompt: prompt ?? FALLBACK.question,
      requestId: requestId("question", title || kindName || "prompt"),
    };
  }

  return null;
}

export interface HilDedupeOptions {
  ttlMs?: number;
  persistDir?: string;
  now?: () => number;
}

/** One announce per pending request. File claims are for Claude's per-hook processes. */
function parseClaim(path: string): { at: number; key: string } | null {
  try {
    const [first, ...rest] = readFileSync(path, "utf8").split("\n");
    const at = Number(first?.trim());
    if (!Number.isFinite(at)) return null;
    return { at, key: rest.join("\n").trim() };
  } catch {
    return null;
  }
}

export class HilDedupe {
  private readonly memory = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly persistDir?: string;
  private readonly now: () => number;

  constructor(opts: HilDedupeOptions = {}) {
    this.ttlMs = opts.ttlMs ?? HIL_DEDUPE_TTL_MS;
    this.persistDir = opts.persistDir;
    this.now = opts.now ?? Date.now;
  }

  tryBegin(key: string): boolean {
    const now = this.now();
    this.prune(now);
    const seen = this.memory.get(key);
    if (seen !== undefined && now - seen < this.ttlMs) return false;
    if (this.persistDir) {
      mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(this.claimPath(key), `${now}\n${key}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    }
    this.memory.set(key, now);
    return true;
  }

  release(key: string): void {
    this.memory.delete(key);
    if (!this.persistDir) return;
    try {
      unlinkSync(this.claimPath(key));
    } catch {
      // Missing claim is the released state.
    }
  }

  recentlyBegan(sessionId: string, kind: HilKind, withinMs = 2_000): boolean {
    const now = this.now();
    const prefix = `${sessionId}:${kind}:`;
    for (const [key, at] of this.memory) {
      if (key.startsWith(prefix) && now - at < withinMs) return true;
    }
    if (!this.persistDir || !existsSync(this.persistDir)) return false;
    for (const name of readdirSync(this.persistDir)) {
      if (!name.endsWith(".claimed")) continue;
      const claim = parseClaim(join(this.persistDir, name));
      if (claim && claim.key.startsWith(prefix) && now - claim.at < withinMs) return true;
    }
    return false;
  }

  private claimPath(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return join(this.persistDir!, `${digest}.claimed`);
  }

  private prune(now: number): void {
    for (const [key, at] of this.memory) {
      if (now - at >= this.ttlMs) this.memory.delete(key);
    }
    if (!this.persistDir || !existsSync(this.persistDir)) return;
    for (const name of readdirSync(this.persistDir)) {
      if (!name.endsWith(".claimed")) continue;
      const path = join(this.persistDir, name);
      const claim = parseClaim(path);
      if (!claim || now - claim.at >= this.ttlMs) {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    }
  }
}

export function defaultHilDedupeDir(env: EchoEnvironment = {}, home = homedir()): string {
  if (env.ECHO_HIL_DEDUPE_DIR) return env.ECHO_HIL_DEDUPE_DIR;
  const state = env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(state, "echo", "hil-dedupe");
}

export async function maybeSpeakHil(opts: {
  event: unknown;
  eventName?: string;
  sessionId: string;
  personaName: string;
  preferredName?: string;
  dedupe: HilDedupe;
  speak: (message: string) => Promise<boolean>;
}): Promise<boolean> {
  const candidate = classifyExtensionHil(opts.event, opts.eventName);
  if (!candidate) return false;
  if (
    opts.eventName === "ui_prompt_start" &&
    candidate.kind === "approval" &&
    opts.dedupe.recentlyBegan(opts.sessionId, "approval")
  ) {
    return false;
  }
  const key = hilDedupeKey(opts.sessionId, candidate);
  if (!opts.dedupe.tryBegin(key)) return false;
  const message = formatHilMessage({
    kind: candidate.kind,
    personaName: opts.personaName,
    preferredName: opts.preferredName,
    prompt: candidate.prompt,
  });
  try {
    const ok = await opts.speak(message);
    if (!ok) opts.dedupe.release(key);
    return ok;
  } catch (error) {
    opts.dedupe.release(key);
    throw error;
  }
}
