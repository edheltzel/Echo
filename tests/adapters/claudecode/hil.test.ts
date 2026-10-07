import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyClaudeHil } from "../../../adapters/claudecode/hooks/lib/hil-event.ts";
import { extractPendingAskUserQuestion, detectResponseState } from "../../../adapters/claudecode/hooks/lib/TranscriptParser.ts";
import { handleHil } from "../../../adapters/claudecode/hooks/handlers/VoiceHil.ts";
import { HilDedupe } from "../../../shared/hil.ts";

function askTranscript(question: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        name: "AskUserQuestion",
        input: {
          questions: [{ question, header: "First problem", options: [{ label: "Docs" }] }],
        },
      }],
    },
  });
}

describe("TranscriptParser AskUserQuestion", () => {
  test("extracts the pending question and labels awaitingInput", () => {
    const raw = askTranscript("What is the first Echo problem or improvement you want tracked?");
    expect(extractPendingAskUserQuestion(raw)).toEqual({
      question: "What is the first Echo problem or improvement you want tracked?",
      header: "First problem",
    });
    expect(detectResponseState("ignored", raw)).toBe("awaitingInput");
  });
});

describe("classifyClaudeHil", () => {
  test("PermissionRequest AskUserQuestion is a question", () => {
    const candidate = classifyClaudeHil({
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "What is the first Echo problem or improvement you want tracked?" }],
      },
    });
    expect(candidate).toMatchObject({
      kind: "question",
      prompt: "What is the first Echo problem or improvement you want tracked?",
    });
  });

  test("PermissionRequest Bash is approval with the host description", () => {
    expect(classifyClaudeHil({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "bun test", description: "Run the verification command?" },
    })).toMatchObject({
      kind: "approval",
      prompt: "Run the verification command?",
    });
  });

  test("idle_prompt is attention; auth_success is ignored", () => {
    expect(classifyClaudeHil({
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      title: "Choose a deployment target.",
    })).toMatchObject({
      kind: "attention",
      prompt: "Choose a deployment target.",
    });
    expect(classifyClaudeHil({
      hook_event_name: "Notification",
      notification_type: "auth_success",
    })).toBeNull();
  });

  test("permission_prompt with transcript awaitingInput is a question", () => {
    expect(classifyClaudeHil({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission",
    }, {
      awaitingInput: true,
      question: "What is the first Echo problem or improvement you want tracked?",
    })).toMatchObject({
      kind: "question",
      prompt: "What is the first Echo problem or improvement you want tracked?",
    });
  });
});

describe("handleHil notify payloads", () => {
  test("speaks a question once and dedupes PermissionRequest plus permission_prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-cc-hil-"));
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, askTranscript("What is the first Echo problem or improvement you want tracked?"));
    const payloads: Array<Record<string, unknown>> = [];
    const dedupe = new HilDedupe({ persistDir: dir });
    const env = { ECHO_PREFERRED_NAME: "Ed" };
    const send = async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      return { ok: true };
    };

    const input = {
      hook_event_name: "PermissionRequest" as const,
      session_id: "sess-1",
      transcript_path: transcript,
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "What is the first Echo problem or improvement you want tracked?" }],
      },
    };

    expect(await handleHil(input, { env, dedupe, send })).toBe(true);
    expect(await handleHil(input, { env, dedupe, send })).toBe(false);
    expect(await handleHil({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      session_id: "sess-1",
      transcript_path: transcript,
      message: "Claude needs your permission",
    }, { env, dedupe, send })).toBe(false);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      message: "Ed, What is the first Echo problem or improvement you want tracked?",
      source: "claudecode",
      session_id: "sess-1",
      voice_enabled: true,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("approval and attention payloads follow the product wording", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const send = async (payload: Record<string, unknown>) => {
      payloads.push(payload);
      return { ok: true };
    };
    const env = { ECHO_PREFERRED_NAME: "Ed" };

    await handleHil({
      hook_event_name: "PermissionRequest",
      session_id: "sess-2",
      tool_name: "Bash",
      tool_input: { description: "Run the verification command?" },
    }, { env, dedupe: new HilDedupe(), send });

    await handleHil({
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      session_id: "sess-2",
      title: "Choose a deployment target.",
    }, { env, dedupe: new HilDedupe(), send });

    expect(payloads[0]?.message).toMatch(/needs approval: Run the verification command\?$/);
    expect(payloads[1]?.message).toMatch(/is paused and needs your attention: Choose a deployment target\.$/);
    expect(String(payloads[0]?.message).startsWith("Ed,")).toBe(true);
  });

  test("neutral wording when the preferred name is unset", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    await handleHil({
      hook_event_name: "PermissionRequest",
      session_id: "sess-3",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "What is the first Echo problem?" }] },
    }, {
      env: {},
      dedupe: new HilDedupe(),
      send: async (payload) => {
        payloads.push(payload);
        return { ok: true };
      },
    });
    expect(payloads[0]?.message).toBe("What is the first Echo problem?");
  });
});
