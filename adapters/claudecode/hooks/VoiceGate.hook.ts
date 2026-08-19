#!/usr/bin/env bun
/**
 * VoiceGate.hook.ts - Block Voice Curls from Subagents (PreToolUse)
 *
 * PURPOSE:
 * Prevents background agents / subagents from sending voice notifications by default.
 * The operator can opt in through ECHO_VOICE_SUPPRESS_SUBAGENTS=false.
 *
 * ROOT CAUSE THIS FIXES:
 * Subagents inherit full host context (CLAUDE.md → SKILL.md → Algorithm),
 * which mandates voice curls at every phase. Without this gate, every
 * spawned agent triggers voice announcements - flooding the voice server.
 *
 * TRIGGER: PreToolUse (matcher: Bash)
 *
 * SUBAGENT DETECTION:
 * Uses stdin JSON `agent_id` field - present when hook fires inside a
 * subagent context. Claude Code delivers agent context via stdin JSON,
 * NOT via environment variables. The old CLAUDE_CODE_AGENT_TASK_ID env
 * var check was unreliable/broken (that env var doesn't exist).
 *
 * DECISION LOGIC:
 * 1. Command doesn't contain "localhost:3246" → PASS (not a voice curl)
 * 2. Command contains "localhost:3246" AND no agent_id in stdin → PASS (main session)
 * 3. Command contains "localhost:3246" AND agent_id present AND suppression enabled
 *    → BLOCK (subagent)
 * 4. Command contains "localhost:3246" AND agent_id present AND suppression disabled
 *    → PASS (explicit opt-in)
 *
 * PERFORMANCE: <5ms. Fast-path exit for non-voice commands.
 */

import { shouldSuppressSubagentVoice } from "@echo/shared/echo-env.ts";
import { decideVoiceGate, isVoiceCurl, type VoiceGateHookInput } from "./lib/voice-gate.ts";

async function main() {
  let input: VoiceGateHookInput;
  try {
    const raw = await Bun.stdin.text();
    if (!raw.trim()) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }
    input = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const command = input.tool_input?.command || "";

  // Fast path: not a voice curl → allow immediately
  if (!isVoiceCurl(command)) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const decision = decideVoiceGate(input, shouldSuppressSubagentVoice());
  if ("decision" in decision) {
    console.error(
      `[VoiceGate] block: subagent voice curl (agent_id: ${input.agent_id}, type: ${input.agent_type || "unknown"})`,
    );
  } else if (input.agent_id) {
    console.error("[VoiceGate] pass: subagent voice curl (explicit opt-in)");
  } else {
    // No agent_id → this is the main session, allow the curl.
    console.error("[VoiceGate] pass: main-session voice curl");
  }
  console.log(JSON.stringify(decision));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
