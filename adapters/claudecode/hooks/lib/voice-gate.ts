/** Pure decision logic for Claude Code's PreToolUse voice gate. */

export interface VoiceGateHookInput {
  tool_name?: string;
  tool_input?: {
    command?: string;
  };
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
}

export interface VoiceGatePass {
  continue: true;
}

export interface VoiceGateBlock {
  decision: "block";
  reason: string;
}

export type VoiceGateDecision = VoiceGatePass | VoiceGateBlock;

const VOICE_ENDPOINTS = ["localhost:3246", "127.0.0.1:3246"];

export function isVoiceCurl(command: string): boolean {
  return VOICE_ENDPOINTS.some((endpoint) => command.includes(endpoint));
}

/**
 * Decide whether one Claude Code Bash invocation should be allowed to reach
 * Echo. Subagent voice stays suppressed unless the caller explicitly opts in.
 */
export function decideVoiceGate(
  input: VoiceGateHookInput,
  suppressSubagents: boolean,
): VoiceGateDecision {
  const command = input.tool_input?.command ?? "";
  if (!isVoiceCurl(command) || !input.agent_id || !suppressSubagents) {
    return { continue: true };
  }

  return {
    decision: "block",
    reason:
      "Voice notifications from subagents are suppressed by default. " +
      "Set ECHO_VOICE_SUPPRESS_SUBAGENTS=false to enable them.",
  };
}
