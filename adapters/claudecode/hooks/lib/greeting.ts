import type { Identity } from './identity';
import { applyNameToken, defaultStartupGreetings } from '@echo/shared/greeting.ts';

/**
 * Resolve the spoken startup catchphrase for a DA identity.
 *
 * Name alone does not announce. `sayName` selects the named default pool.
 * Configured lines without `{name}` stay verbatim; token-bearing lines honor
 * `sayName`. A repo with no persona keeps the inherited global pool.
 */
export function resolveStartupCatchphrase(identity: Identity, random: () => number = Math.random): string {
  const pool = resolveStartupCatchphrases(identity);
  return pool[Math.floor(random() * pool.length)] ?? "standing by";
}

export function resolveStartupCatchphrases(identity: Identity): string[] {
  const configured = identity.startupCatchphrases?.filter(
    (phrase): phrase is string => typeof phrase === 'string' && phrase.trim().length > 0,
  );
  const pool = configured?.length
    ? configured
    : typeof identity.startupCatchphrase === 'string' && identity.startupCatchphrase.trim().length > 0
      ? [identity.startupCatchphrase]
      : defaultStartupGreetings(Boolean(identity.sayName));
  return pool.map((phrase) => applyNameToken(phrase, identity.displayName, Boolean(identity.sayName)));
}

function normalizeSpokenText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function findStartupCatchphraseMatch(spokenText: string, identity: Identity): string | undefined {
  const normalized = normalizeSpokenText(spokenText);
  return resolveStartupCatchphrases(identity).find((catchphrase) => {
    const catchNormalized = normalizeSpokenText(catchphrase);
    return catchNormalized.length > 0 && normalized === catchNormalized;
  });
}
