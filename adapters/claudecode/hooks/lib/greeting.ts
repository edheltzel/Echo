import type { Identity } from './identity';
import { DEFAULT_PERSONA_GREETINGS } from '@echo/shared/greeting.ts';

/**
 * Resolve the spoken startup catchphrase for a DA identity.
 *
 * A repo that renamed the persona but kept the default greeting (name + voice via
 * `/echo-voice`, no `startupCatchphrases` of its own) announces ITS name — using the
 * `{name}` default pool — instead of the inherited global pool (which names a different
 * persona). A project that set its own catchphrases still wins; a repo with no persona
 * keeps the global pool untouched. `{name}` is substituted with the resolved displayName.
 * `random` is injectable for deterministic tests.
 */
export function resolveStartupCatchphrase(identity: Identity, random: () => number = Math.random): string {
  const daName = identity.displayName;
  const pool = (identity.personaFromProject && !identity.catchphrasesFromProject)
    ? DEFAULT_PERSONA_GREETINGS
    : identity.startupCatchphrases;
  const raw = pool?.length
    ? pool[Math.floor(random() * pool.length)]
    : identity.startupCatchphrase || `${daName} standing by`;
  return raw.replace(/\{name\}/gi, daName);
}
