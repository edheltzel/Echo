import {
  clipHilPrompt,
  promptFromAskUserQuestionInput,
  promptFromToolInput,
  type HilCandidate,
  type HilKind,
} from "@echo/shared/hil.ts";

export interface ClaudeHilInput {
  hook_event_name?: string;
  notification_type?: string;
  tool_name?: string;
  tool_input?: unknown;
  message?: string;
  title?: string;
  session_id?: string;
  transcript_path?: string;
  agent_id?: string;
  last_assistant_message?: string;
}

export interface ClaudeTranscriptHint {
  awaitingInput: boolean;
  question?: string;
}

const QUESTION_TOOLS = new Set(["AskUserQuestion"]);
const IGNORED_NOTIFICATIONS = new Set([
  "auth_success",
  "elicitation_complete",
  "elicitation_response",
  "agent_completed",
  "quota_auto_resume_fired",
  "quota_auto_resume_stale",
  "quota_auto_resume_disabled",
]);

function requestId(kind: HilKind, ...parts: Array<string | undefined>): string {
  const rest = parts.map((part) => clipHilPrompt(part ?? "", 80).toLowerCase()).filter(Boolean);
  return [kind, ...rest].join(":");
}

function hostPrompt(input: ClaudeHilInput, hint?: ClaudeTranscriptHint): string | undefined {
  if (hint?.question?.trim()) return hint.question.trim();
  if (input.tool_name) {
    const fromTool = promptFromToolInput(input.tool_name, input.tool_input);
    if (fromTool) return fromTool;
  }
  if (typeof input.title === "string" && input.title.trim() && input.title.trim().toLowerCase() !== "permission needed") {
    return input.title.trim();
  }
  if (typeof input.message === "string" && input.message.trim()) return input.message.trim();
  if (input.tool_name) return input.tool_name;
  return undefined;
}

function isQuestion(input: ClaudeHilInput, hint?: ClaudeTranscriptHint): boolean {
  if (input.tool_name && QUESTION_TOOLS.has(input.tool_name)) return true;
  if (hint?.awaitingInput) return true;
  if (hint?.question) return true;
  if (input.tool_name === "AskUserQuestion") return true;
  return false;
}

export function classifyClaudeHil(input: ClaudeHilInput, hint?: ClaudeTranscriptHint): HilCandidate | null {
  const event = input.hook_event_name ?? "";
  const notification = input.notification_type ?? "";

  if (event === "PermissionRequest") {
    const kind: HilKind = isQuestion(input, hint) ? "question" : "approval";
    const prompt = hostPrompt(input, hint);
    return {
      kind,
      prompt: prompt ?? (kind === "question" ? "a question needs your answer" : input.tool_name ?? "a pending request"),
      requestId: requestId(kind, promptFromAskUserQuestionInput(input.tool_input) ?? prompt ?? input.tool_name),
    };
  }

  if (event === "Notification") {
    if (!notification || IGNORED_NOTIFICATIONS.has(notification)) return null;
    if (notification === "idle_prompt" || notification === "agent_needs_input") {
      const prompt = hostPrompt(input, hint);
      return {
        kind: "attention",
        prompt: prompt ?? "the session is waiting",
        requestId: requestId("attention", notification),
      };
    }
    if (notification === "elicitation_dialog" || notification === "elicitation_url_dialog") {
      const prompt = hostPrompt(input, hint);
      return {
        kind: "question",
        prompt: prompt ?? "a question needs your answer",
        requestId: requestId("question", prompt),
      };
    }
    if (notification === "permission_prompt") {
      const kind: HilKind = isQuestion(input, hint) ? "question" : "approval";
      const prompt = hostPrompt(input, hint);
      return {
        kind,
        prompt: prompt ?? (kind === "question" ? "a question needs your answer" : "a pending request"),
        requestId: requestId(kind, hint?.question ?? prompt),
      };
    }
  }

  return null;
}
