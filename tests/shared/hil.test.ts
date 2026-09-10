import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HilDedupe,
  classifyExtensionHil,
  formatHilMessage,
  maybeSpeakHil,
  preferredHumanName,
} from "../../shared/hil.ts";

describe("preferredHumanName", () => {
  test("returns a configured name", () => {
    expect(preferredHumanName({ ECHO_PREFERRED_NAME: "Ed" })).toBe("Ed");
  });

  test("does not guess when unset or blank", () => {
    expect(preferredHumanName({})).toBeUndefined();
    expect(preferredHumanName({ ECHO_PREFERRED_NAME: "  " })).toBeUndefined();
    expect(preferredHumanName({ ECHO_PREFERRED_NAME: "User" })).toBe("User");
  });
});

describe("formatHilMessage", () => {
  test("addresses a question with the preferred name", () => {
    expect(formatHilMessage({
      kind: "question",
      personaName: "Atlas",
      preferredName: "Ed",
      prompt: "What is the first Echo problem or improvement you want tracked?",
    })).toBe("Ed, What is the first Echo problem or improvement you want tracked?");
  });

  test("uses the host prompt for approval", () => {
    expect(formatHilMessage({
      kind: "approval",
      personaName: "Atlas",
      preferredName: "Ed",
      prompt: "Run the verification command?",
    })).toBe("Ed, Atlas needs approval: Run the verification command?");
  });

  test("uses the host prompt for attention", () => {
    expect(formatHilMessage({
      kind: "attention",
      personaName: "Atlas",
      preferredName: "Ed",
      prompt: "Choose a deployment target.",
    })).toBe("Ed, Atlas is paused and needs your attention: Choose a deployment target.");
  });

  test("stays nameless when no preferred name is configured", () => {
    expect(formatHilMessage({
      kind: "question",
      personaName: "Atlas",
      prompt: "What is the first Echo problem?",
    })).toBe("What is the first Echo problem?");
    expect(formatHilMessage({
      kind: "approval",
      personaName: "Atlas",
      prompt: "Run the verification command?",
    })).toBe("Atlas needs approval: Run the verification command?");
  });

  test("uses a concise generic fallback when the host has no title", () => {
    expect(formatHilMessage({ kind: "question", personaName: "Pi" })).toBe("a question needs your answer");
    expect(formatHilMessage({ kind: "approval", personaName: "omp" })).toBe("omp needs approval: a pending request");
    expect(formatHilMessage({ kind: "attention", personaName: "Pi" })).toBe(
      "Pi is paused and needs your attention: the session is waiting",
    );
  });
});

describe("classifyExtensionHil", () => {
  test("maps tool_approval_requested to approval", () => {
    expect(classifyExtensionHil({
      type: "tool_approval_requested",
      toolCallId: "c1",
      toolName: "bash",
      reason: "Run the verification command?",
    })).toEqual({
      kind: "approval",
      prompt: "Run the verification command?",
      requestId: "approval:c1:bash",
    });
  });

  test("maps ui_prompt_start select/input to question and skips Echo consent", () => {
    expect(classifyExtensionHil({
      type: "ui_prompt_start",
      kind: "select",
      title: "What is the first Echo problem?",
    }, "ui_prompt_start")?.kind).toBe("question");
    expect(classifyExtensionHil({
      type: "ui_prompt_start",
      kind: "confirm",
      title: "Allow Echo voice replies for this Pi session?",
    }, "ui_prompt_start")).toBeNull();
    expect(classifyExtensionHil({
      type: "ui_prompt_start",
      kind: "custom",
      title: "Choose a deployment target.",
    }, "ui_prompt_start")?.kind).toBe("attention");
  });
});

describe("HilDedupe", () => {
  test("one announce per request; failed speak can retry", async () => {
    const dedupe = new HilDedupe();
    const spoken: string[] = [];
    const event = {
      type: "tool_approval_requested",
      toolCallId: "c1",
      toolName: "bash",
      reason: "Run the verification command?",
    };
    const statuses = [false, true, true];
    const speak = async (message: string) => {
      spoken.push(message);
      return statuses.shift() ?? true;
    };

    expect(await maybeSpeakHil({
      event,
      eventName: "tool_approval_requested",
      sessionId: "s1",
      personaName: "Atlas",
      preferredName: "Ed",
      dedupe,
      speak,
    })).toBe(false);
    expect(await maybeSpeakHil({
      event,
      eventName: "tool_approval_requested",
      sessionId: "s1",
      personaName: "Atlas",
      preferredName: "Ed",
      dedupe,
      speak,
    })).toBe(true);
    expect(await maybeSpeakHil({
      event,
      eventName: "tool_approval_requested",
      sessionId: "s1",
      personaName: "Atlas",
      preferredName: "Ed",
      dedupe,
      speak,
    })).toBe(false);

    expect(spoken).toEqual([
      "Ed, Atlas needs approval: Run the verification command?",
      "Ed, Atlas needs approval: Run the verification command?",
    ]);
  });

  test("ui_prompt_start confirm does not re-speak after tool_approval_requested", async () => {
    const dedupe = new HilDedupe();
    const spoken: string[] = [];
    const speak = async (message: string) => {
      spoken.push(message);
      return true;
    };
    await maybeSpeakHil({
      event: { type: "tool_approval_requested", toolCallId: "c1", toolName: "bash", reason: "npm test" },
      eventName: "tool_approval_requested",
      sessionId: "s1",
      personaName: "omp",
      dedupe,
      speak,
    });
    await maybeSpeakHil({
      event: { type: "ui_prompt_start", kind: "confirm", title: "Approve bash?" },
      eventName: "ui_prompt_start",
      sessionId: "s1",
      personaName: "omp",
      dedupe,
      speak,
    });
    expect(spoken).toHaveLength(1);
  });

  test("persist dir claims survive a fresh HilDedupe instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-hil-"));
    try {
      const first = new HilDedupe({ persistDir: dir });
      expect(first.tryBegin("s1:approval:c1")).toBe(true);
      const second = new HilDedupe({ persistDir: dir });
      expect(second.tryBegin("s1:approval:c1")).toBe(false);
      expect(second.recentlyBegan("s1", "approval", 30_000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
