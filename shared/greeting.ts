// Startup-greeting helpers shared by every host adapter.
//
// Startup only, not per-turn speech. Default pool is nameless. Setting a
// persona name does not announce it; `daidentity.sayName: true` opts into the
// named pool (`{name}`). Custom `startupCatchphrases` stay verbatim except
// that `{name}` still honors sayName.

import { parseEchoBoolean } from "./echo-env.ts";

export const NAMELESS_STARTUP_GREETINGS: string[] = [
  "standing by",
  "ready when you are",
  "waiting for direction",
  "engaged",
];

export const NAMED_STARTUP_GREETINGS: string[] = [
  "{name}, standing by",
  "{name}, ready when you are",
  "{name}, waiting for direction",
  "{name} engaged",
];

/** Default startup pool. Nameless unless sayName is on. */
export const DEFAULT_PERSONA_GREETINGS: string[] = NAMELESS_STARTUP_GREETINGS;

export function defaultStartupGreetings(sayName = false): string[] {
  return sayName ? NAMED_STARTUP_GREETINGS : NAMELESS_STARTUP_GREETINGS;
}

export function resolvePersonaStartupGreetings(
  base: string[],
  override: string[] | undefined,
  sayName = false,
): string[] {
  if (override !== undefined) return override;
  if (base === NAMELESS_STARTUP_GREETINGS || base === NAMED_STARTUP_GREETINGS) {
    return defaultStartupGreetings(sayName);
  }
  return base;
}

/** Fill `{name}` only when sayName is on. Custom lines without the token stay verbatim. */
export function applyNameToken(text: string, name: string, sayName = false): string {
  if (!/\{name\}/i.test(text)) return text;
  if (!sayName) {
    return text
      .replace(/\{name\}/gi, "")
      .replace(/\s+,/g, ",")
      .replace(/^,\s*/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return text.replace(/\{name\}/gi, name);
}

/** Catchphrases and sayName resolved project-over-global per key. */
export function personaGreetingFields(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
): { phrases?: string[]; sayName?: boolean } {
  const rawPhrases = project?.startupCatchphrases
    ?? global?.startupCatchphrases;
  const phrases = Array.isArray(rawPhrases)
    ? rawPhrases.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : undefined;
  const rawSay = project && Object.hasOwn(project, "sayName")
    ? project.sayName
    : global?.sayName;
  const out: { phrases?: string[]; sayName?: boolean } = {};
  if (phrases && phrases.length > 0) out.phrases = phrases;
  if (rawSay !== undefined) out.sayName = parseEchoBoolean(rawSay, false);
  return out;
}
