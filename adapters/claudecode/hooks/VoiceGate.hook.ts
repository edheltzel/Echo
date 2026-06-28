#!/usr/bin/env bun
/**
 * VoiceGate.hook.ts - Block Voice Curls from Subagents (PreToolUse)
 *
 * PURPOSE:
 * Prevents background agents / subagents from sending voice notifications.
 * Only the main terminal session is allowed to curl the voice server at localhost:8888.
 *
 * ROOT CAUSE THIS FIXES:
 * Subagents inherit full host context (CLAUDE.md → SKILL.md → Algorithm),
 * which mandates voice curls at every phase. Without this gate, every
 * spawned agent triggers voice announcements — flooding the voice server.
 *
 * TRIGGER: PreToolUse (matcher: Bash)
 *
 * SUBAGENT DETECTION:
 * Uses stdin JSON `agent_id` field — present when hook fires inside a
 * subagent context. Claude Code delivers agent context via stdin JSON,
 * NOT via environment variables. The old CLAUDE_CODE_AGENT_TASK_ID env
 * var check was unreliable/broken (that env var doesn't exist).
 *
 * DECISION LOGIC:
 * 1. Command doesn't contain "localhost:8888" → PASS (not a voice curl)
 * 2. Command contains "localhost:8888" AND no agent_id in stdin → PASS (main session)
 * 3. Command contains "localhost:8888" AND agent_id present → BLOCK (subagent)
 *
 * PERFORMANCE: <5ms. Fast-path exit for non-voice commands.
 */

interface HookInput {
  tool_name: string;
  tool_input: {
    command?: string;
  };
  session_id: string;
  agent_id?: string;
  agent_type?: string;
}

async function main() {
  let input: HookInput;
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

  const command = input.tool_input?.command || '';

  // Fast path: not a voice curl → allow immediately
  const isVoiceCurl = command.includes('localhost:8888') || command.includes('127.0.0.1:8888');
  if (!isVoiceCurl) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // It's a voice curl — check if we're in a subagent context
  // agent_id is present in stdin JSON when the hook fires inside a subagent
  const agentId = input.agent_id;
  const agentType = input.agent_type;

  if (!agentId) {
    // No agent_id → this is the main session, allow the curl
    console.error('[VoiceGate] pass: main-session voice curl');
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  // Subagent trying to send voice → block
  console.error(`[VoiceGate] block: subagent voice curl (agent_id: ${agentId}, type: ${agentType || 'unknown'})`);
  console.log(JSON.stringify({
    decision: "block",
    reason: "Voice notifications are only sent from the main session. Subagent voice curls are suppressed."
  }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
