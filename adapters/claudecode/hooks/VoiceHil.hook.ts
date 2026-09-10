#!/usr/bin/env bun
/**
 * VoiceHil.hook.ts - Announce when Claude Code needs a human (#107)
 *
 * TRIGGER: PermissionRequest (immediate tool approval / AskUserQuestion)
 *          Notification (permission_prompt, idle_prompt, elicitation, agent_needs_input)
 *
 * OBSERVE ONLY. Does not allow, deny, or rewrite tool input.
 */

import { handleHil } from "./handlers/VoiceHil";
import type { ClaudeHilInput } from "./lib/hil-event";

async function readInput(): Promise<ClaudeHilInput | null> {
  try {
    const raw = await Bun.stdin.text();
    if (!raw.trim()) return null;
    return JSON.parse(raw) as ClaudeHilInput;
  } catch {
    return null;
  }
}

async function main() {
  const input = await readInput();
  if (!input) {
    process.exit(0);
    return;
  }

  try {
    await handleHil(input);
  } catch (err) {
    console.error("[VoiceHil] Handler failed:", err);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[VoiceHil] Fatal:", err);
  process.exit(0);
});
