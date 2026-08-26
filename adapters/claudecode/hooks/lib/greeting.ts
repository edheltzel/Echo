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
  const useCustom = Boolean(identity.catchphrasesFromProject)
    || (!identity.personaFromProject && Boolean(identity.startupCatchphrases?.length));
  const pool = useCustom && identity.startupCatchphrases?.length
    ? identity.startupCatchphrases
    : defaultStartupGreetings(Boolean(identity.sayName));
  const raw = pool[Math.floor(random() * pool.length)]
    ?? identity.startupCatchphrase
    ?? "standing by";
  return applyNameToken(raw, identity.displayName, Boolean(identity.sayName));
}
