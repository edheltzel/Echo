import { describe, expect, test } from "bun:test";
import { buildNotifyPayload } from "../../../shared/notify-client";
import type { PiVoiceConfig } from "../../../adapters/pi/config";

const config: PiVoiceConfig = {
  endpoint: "http://localhost:8888/notify",
  title: "Pi Notification",
  startupCatchphrases: ["Pi ready."],
  personaName: "Pi",
  voiceId: "kai",
  voiceEnabled: true,
  greetOnSessionStart: true,
  speakCompletions: true,
  suppressInSubagents: true,
};

describe("Pi notify payloads", () => {
  test("include source and session metadata", () => {
    expect(buildNotifyPayload(config, "Task complete.", "pi", "session-1")).toEqual({
      message: "Task complete.",
      title: "Pi Notification",
      voice_enabled: true,
      voice_id: "kai",
      session_id: "session-1",
      source: "pi",
    });
  });
});
