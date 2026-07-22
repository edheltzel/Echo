// Startup-greeting helpers shared by every host adapter.
//
// When a repo sets a project persona NAME but no startup lines of its own, the
// greeting should announce that name rather than a neutral pool (pi/omp) or an
// inherited global persona's lines (Claude Code). This is the default name pool
// used in that case — the neutral session-ready lines, but name-prefixed via the
// `{name}` token, which `applyNameToken` substitutes with the resolved persona name.
//
// Custom `startupCatchphrases` (project- or global-configured) still win over this;
// a repo with no persona keeps the neutral / global pool untouched.
export const DEFAULT_PERSONA_GREETINGS: string[] = [
  "{name} online and standing by.",
  "{name}, ready when you are.",
  "{name} standing by.",
  "{name} online. Let's get to work.",
  "{name} up and listening.",
];

/** Substitute the `{name}` token (case-insensitive) with the persona name. */
export function applyNameToken(text: string, name: string): string {
  return text.replace(/\{name\}/gi, name);
}
