import { describe, it, expect } from "bun:test";
import {
  handleCodexHookResult,
  type CodexHookPayload,
} from "../../../adapters/codex/hook.ts";
import { loadCodexVoiceConfig } from "../../../adapters/codex/config.ts";

describe("codex live mode suppression", () => {
  it("skips speaking when live mode is active (is_live: true)", async () => {
    const payload: CodexHookPayload = {
      hook_event_name: "stop",
      session_id: "sess-live-1",
      last_assistant_message: "🗣️ Codex: Task completed successfully.",
      is_live: true,
    };

    const config = loadCodexVoiceConfig();
    const result = await handleCodexHookResult(payload, config);

    expect(result).toBe("skipped");
  });

  it("skips speaking when live mode is active (isLive: true)", async () => {
    const payload: CodexHookPayload = {
      hookEventName: "stop",
      sessionId: "sess-live-2",
      lastAssistantMessage: "🗣️ Codex: All done.",
      isLive: true,
    };

    const config = loadCodexVoiceConfig();
    const result = await handleCodexHookResult(payload, config);

    expect(result).toBe("skipped");
  });

  it("skips speaking when CODEX_LIVE environment variable is set", async () => {
    const payload: CodexHookPayload = {
      hook_event_name: "stop",
      session_id: "sess-live-3",
      last_assistant_message: "🗣️ Codex: Done.",
    };

    const env = { CODEX_LIVE: "true" };
    const config = loadCodexVoiceConfig(env);
    const result = await handleCodexHookResult(payload, config, env);

    expect(result).toBe("skipped");
  });

  it("does not skip when live mode is false", async () => {
    const payload: CodexHookPayload = {
      hook_event_name: "stop",
      session_id: "sess-normal-1",
      last_assistant_message: "🗣️ Codex: Finished the work.",
      is_live: false,
    };

    const config = loadCodexVoiceConfig();
    const result = await handleCodexHookResult(payload, config);

    // Should not be skipped due to live mode (may be skipped for other reasons like subagent)
    expect(result).not.toBe("skipped");
  });

  it("does not skip when live mode is not specified", async () => {
    const payload: CodexHookPayload = {
      hook_event_name: "stop",
      session_id: "sess-normal-2",
      last_assistant_message: "🗣️ Codex: Work completed.",
    };

    const config = loadCodexVoiceConfig();
    const result = await handleCodexHookResult(payload, config);

    // Should proceed normally
    expect(result).not.toBe("skipped");
  });

  it("respects subagent suppression independent of live mode", async () => {
    const payload: CodexHookPayload = {
      hook_event_name: "subagent_stop",
      session_id: "sess-subagent-1",
      last_assistant_message: "🗣️ Codex: Subagent work done.",
      is_live: false,
    };

    const config = loadCodexVoiceConfig();
    const result = await handleCodexHookResult(payload, config);

    expect(result).toBe("skipped");
  });

  it("handles live mode with subagent event (subagent takes precedence)", async () => {
    const payload: CodexHookPayload = {
      hook_event_name: "subagent_stop",
      session_id: "sess-sub-live-1",
      last_assistant_message: "🗣️ Codex: Subagent result.",
      is_live: true,
    };

    const config = loadCodexVoiceConfig();
    const result = await handleCodexHookResult(payload, config);

    // Both conditions suppress, result should be skipped
    expect(result).toBe("skipped");
  });
});
