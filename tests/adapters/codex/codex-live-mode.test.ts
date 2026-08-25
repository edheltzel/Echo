import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleCodexHookResult,
  type CodexHookPayload,
} from "../../../adapters/codex/hook.ts";
import type { CodexVoiceConfig } from "../../../adapters/codex/config.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

const config: CodexVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "Codex Notification",
  startupCatchphrases: ["Codex online."],
  personaName: "Codex",
  voiceId: "codex",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
};

function stopPayload(transcriptPath: string, turnId: string): CodexHookPayload {
  return {
    session_id: "sess-1",
    turn_id: turnId,
    transcript_path: transcriptPath,
    cwd: "/project",
    hook_event_name: "Stop",
    model: "gpt-5.6-codex",
    permission_mode: "default",
    stop_hook_active: false,
    last_assistant_message: "Task completed successfully.",
  };
}

function turnContext(turnId: string, realtimeActive: boolean): string {
  return JSON.stringify({
    timestamp: "2026-08-24T12:00:00Z",
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: "/project",
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      model: "gpt-5.6-codex",
      realtime_active: realtimeActive,
      summary: "auto",
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("codex live mode suppression", () => {
  test("uses the matching Codex turn_context realtime state without muting the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-codex-live-"));
    tempDirs.push(dir);
    const transcriptPath = join(dir, "rollout.jsonl");
    writeFileSync(transcriptPath, `${turnContext("turn-live", true)}\n`);

    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response("{}", { status: 202 });
    };

    expect(await handleCodexHookResult(stopPayload(transcriptPath, "turn-live"), config)).toBe("skipped");
    expect(requests).toEqual([]);

    appendFileSync(transcriptPath, `${turnContext("turn-normal", false)}\n`);
    expect(await handleCodexHookResult(stopPayload(transcriptPath, "turn-normal"), config)).toBe("sent");
    expect(requests).toEqual(["http://voice.example/notify"]);
    expect(requests.some((request) => new URL(request).pathname === "/mute")).toBe(false);
  });

  test("scopes the realtime state to this turn even when the transcript is out of order", async () => {
    // Per-turn scoping is what keeps "someone once used live in this session" from silencing
    // the rest of it. A transcript whose last turn_context belongs to a different turn - the
    // ordinary case once a live turn is followed by more turns, or a resumed rollout - is only
    // answered correctly by matching turn_id, never by taking the newest record.
    const dir = mkdtempSync(join(tmpdir(), "echo-codex-live-order-"));
    tempDirs.push(dir);
    const transcriptPath = join(dir, "rollout.jsonl");
    writeFileSync(
      transcriptPath,
      [
        turnContext("turn-normal", false),
        turnContext("turn-live", true),
        // Interleaved records the scan must skip rather than mistake for a turn context.
        JSON.stringify({ type: "event_msg", payload: { turn_id: "turn-normal", realtime_active: true } }),
        "",
      ].join("\n"),
    );

    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return new Response("{}", { status: 202 });
    };

    // The newest turn_context says realtime; this turn's does not, so this turn still speaks.
    expect(await handleCodexHookResult(stopPayload(transcriptPath, "turn-normal"), config)).toBe("sent");
    expect(requests).toEqual(["http://voice.example/notify"]);

    // And the live turn stays silent even though a later record for another turn says otherwise.
    appendFileSync(transcriptPath, `${turnContext("turn-later", false)}\n`);
    expect(await handleCodexHookResult(stopPayload(transcriptPath, "turn-live"), config)).toBe("skipped");
    expect(requests).toEqual(["http://voice.example/notify"]);
  });
});
