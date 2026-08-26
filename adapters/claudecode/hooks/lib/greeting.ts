import type { Identity } from './identity';
import { applyNameToken, defaultStartupGreetings } from '@echo/shared/greeting.ts';

/**
 * Resolve the spoken startup catchphrase for a DA identity.
 *
 * Name alone does not announce. `sayName` selects the named default pool;
 * project-authored catchphrases stay verbatim. A repo with no persona keeps
 * the inherited global pool. `{name}` honors sayName.
 */
export function resolveStartupCatchphrase(identity: Identity, random: () => number = Math.random): string {
  const pool = resolveStartupCatchphrases(identity);
  return pool[Math.floor(random() * pool.length)] ?? "standing by";
}

export function resolveStartupCatchphrases(identity: Identity): string[] {
  const pool = identity.startupCatchphrases?.length
    ? identity.startupCatchphrases
    : identity.startupCatchphrase
      ? [identity.startupCatchphrase]
      : defaultStartupGreetings(Boolean(identity.sayName));
  return pool.map((phrase) => applyNameToken(phrase, identity.displayName, Boolean(identity.sayName)));
}
