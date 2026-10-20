import type { HarnessId } from "./extension.ts";

/** Speech-only harness labels; persona names and normal turn speech stay unchanged. */
const STARTUP_GREETINGS = {
  claudecode: "Claude code, ready.",
  jcode: "Jay code, ready.",
  grok: "Grok, ready.",
  codex: "Codex, ready.",
  pi: "Pie, ready.",
  omp: "Oh em pee, ready.",
  opencode: "Open code, ready.",
} as const satisfies Record<Exclude<HarnessId, "mcp">, string>;

/** Call only for eligible startup events, after applying the host's mute/suppression policy. */
export function startupGreeting(harness: keyof typeof STARTUP_GREETINGS): string {
  return STARTUP_GREETINGS[harness];
}
