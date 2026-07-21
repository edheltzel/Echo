import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Persona scaffold — the host-neutral core of the pi/omp `/echo-voice` command.
//
// Writes a project-local `daidentity` persona (name + edge-tts voice) into a host's
// native config, the deterministic writer analog of the Claude Code `/echo-voice`
// markdown command. The two host adapters differ only in file format (pi: JSON
// `.pi/settings.json`; omp: YAML `.omp/config.yml`) and file path, so everything
// format-independent lives here and is unit-tested here.
//
// Invariant (the brief's central "never clobber"): merging preserves every existing
// key — other top-level settings AND other `daidentity` sub-keys (startupCatchphrases,
// extra voices). The readers (adapters' `loadProjectPersona`) are deliberately lenient
// with a malformed file (→ no override); this WRITER is deliberately strict — a present
// but unparseable file ABORTS rather than overwriting the user's content with `{}`.

/** Thrown when an existing config file is present but cannot be parsed. */
export class MalformedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedConfigError";
  }
}

// An edge-tts voice name (e.g. "en-US-AndrewNeural", "en-GB-RyanNeural"). Mirrors
// `EDGE_VOICE_RE` in core/server.ts — replicated, not imported, because adapters and
// shared/ must never import core/ (the daemon ships independently). Keep in sync.
const EDGE_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z-]+Neural$/;

export function looksLikeEdgeVoice(identifier: string | null | undefined): boolean {
  return !!identifier && EDGE_VOICE_RE.test(identifier);
}

/** Split a raw command-argument string into an optional persona name + voice. */
export function parsePersonaArgs(args: string): { name?: string; voice?: string } {
  const tokens = args.trim().split(/\s+/).filter((t) => t.length > 0);
  return { name: tokens[0], voice: tokens[1] };
}

/**
 * Set the persona name + voice on a parsed config object, preserving every other key.
 * Only `daidentity.name` and `daidentity.voices.main.voiceId` are touched; existing
 * daidentity siblings (startupCatchphrases, other voices) and all top-level keys stay.
 * Mutates and returns `config`.
 */
export function applyPersona(
  config: Record<string, any>,
  name: string,
  voiceId: string,
): Record<string, any> {
  const daidentity = (config.daidentity && typeof config.daidentity === "object")
    ? config.daidentity as Record<string, any>
    : {};
  const voices = (daidentity.voices && typeof daidentity.voices === "object")
    ? daidentity.voices as Record<string, any>
    : {};
  const main = (voices.main && typeof voices.main === "object")
    ? voices.main as Record<string, any>
    : {};

  config.daidentity = {
    ...daidentity,
    name,
    voices: { ...voices, main: { ...main, voiceId } },
  };
  return config;
}

/** Parse existing JSON config text: absent/empty → `{}`; malformed → throw. */
function parseJsonConfig(raw: string | null): Record<string, any> {
  if (raw === null || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedConfigError("existing config is not valid JSON");
  }
  if (parsed === null) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MalformedConfigError("existing config is not a JSON object");
  }
  return parsed as Record<string, any>;
}

// Bun's native YAML parser/serializer (Bun >= 1.2). Cast because the installed
// @types/bun may predate the typing. `stringify(obj, null, 2)` emits block style.
const bunYaml = (Bun as unknown as {
  YAML: { parse: (s: string) => unknown; stringify: (v: unknown, replacer: null, indent: number) => string };
}).YAML;

/** Parse existing YAML config text: absent/empty → `{}`; malformed → throw. */
function parseYamlConfig(raw: string | null): Record<string, any> {
  if (raw === null || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = bunYaml.parse(raw);
  } catch {
    throw new MalformedConfigError("existing config is not valid YAML");
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MalformedConfigError("existing config is not a YAML mapping");
  }
  return parsed as Record<string, any>;
}

/** Merge the persona into JSON config text (pi). Returns pretty JSON with a trailing newline. */
export function mergePersonaJson(raw: string | null, name: string, voiceId: string): string {
  return JSON.stringify(applyPersona(parseJsonConfig(raw), name, voiceId), null, 2) + "\n";
}

/** Merge the persona into YAML config text (omp). Returns block-style YAML. */
export function mergePersonaYaml(raw: string | null, name: string, voiceId: string): string {
  return bunYaml.stringify(applyPersona(parseYamlConfig(raw), name, voiceId), null, 2);
}

// ── `/echo-voice` command factory (shared by the pi + omp adapters) ───────────
// The two adapters' command handlers are identical except for the config file
// (path + format), so the whole flow — parse args, prompt for anything missing,
// validate the edge-tts voice, merge-preserving-write, confirm — lives here.

/** Minimal structural view of the host UI the command needs (pi + omp both satisfy it). */
export interface ScaffoldUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Minimal structural view of the host command context (a superset of both SDKs'). */
export interface ScaffoldContext {
  cwd?: string;
  ui: ScaffoldUi;
}

export interface EchoVoiceCommandOptions {
  /** Project-relative config path segments, e.g. `[".pi", "settings.json"]`. */
  configPath: string[];
  /** Format-specific merge (`mergePersonaJson` for pi, `mergePersonaYaml` for omp). */
  merge: (raw: string | null, name: string, voiceId: string) => string;
}

export interface EchoVoiceCommand {
  description: string;
  handler: (args: string, ctx: ScaffoldContext) => Promise<void>;
}

/**
 * Build the `/echo-voice` command for a host: set a project-local persona
 * (name + edge-tts voice) in that repo's native config, merged so every other
 * key is preserved. Missing name/voice are prompted interactively; a present but
 * unparseable config aborts rather than clobbering it.
 */
export function createEchoVoiceCommand(opts: EchoVoiceCommandOptions): EchoVoiceCommand {
  return {
    description: "Set this project's Echo persona (name + edge-tts voice)",
    handler: async (args, ctx) => {
      const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : undefined;
      if (!cwd) {
        ctx.ui.notify("No project directory — open Echo inside a repo to set a persona.", "error");
        return;
      }

      const parsed = parsePersonaArgs(args);
      const name = (parsed.name ?? (await ctx.ui.input("Persona name", "e.g. Echo")))?.trim();
      if (!name) {
        ctx.ui.notify("Cancelled — no persona name given.", "warning");
        return;
      }

      const voice = (parsed.voice ?? (await ctx.ui.input("edge-tts voice id", "e.g. en-US-AndrewNeural")))?.trim();
      if (!voice) {
        ctx.ui.notify("Cancelled — no voice given.", "warning");
        return;
      }
      if (!looksLikeEdgeVoice(voice)) {
        ctx.ui.notify(
          `"${voice}" doesn't look like an edge-tts voice (e.g. en-US-AndrewNeural). List them: bun scripts/preview-voices.ts --list`,
          "error",
        );
        return;
      }

      const target = join(cwd, ...opts.configPath);
      try {
        const raw = existsSync(target) ? readFileSync(target, "utf8") : null;
        const merged = opts.merge(raw, name, voice);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, merged);
      } catch (error) {
        const reason = error instanceof MalformedConfigError
          ? `${error.message} — fix it by hand first`
          : error instanceof Error
            ? error.message
            : String(error);
        ctx.ui.notify(`Not writing ${target}: ${reason}.`, "error");
        return;
      }

      ctx.ui.notify(
        `Set persona "${name}" (${voice}) in ${target}. Restart the session to hear it.`,
        "info",
      );
    },
  };
}
