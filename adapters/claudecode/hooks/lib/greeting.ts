import { startupGreeting } from '@echo/shared/greeting.ts';

function normalizeSpokenText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

const STARTUP_LINE = normalizeSpokenText(startupGreeting("claudecode"));

/** Suppress only a complete echoed startup line, never an ordinary sentence containing it. */
export function matchesStartupGreeting(spokenText: string): boolean {
  return normalizeSpokenText(spokenText) === STARTUP_LINE;
}
