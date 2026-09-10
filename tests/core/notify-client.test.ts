import { describe, expect, test } from "bun:test";
import { normalizeNotifyPayload } from "../../core/notify-client";

describe("notify client payload normalization", () => {
  test("preserves adapter metadata and removes undefined optional fields", () => {
    const payload = normalizeNotifyPayload({
      message: "Task complete",
      title: "Pi Notification",
      voice_enabled: true,
      voice_id: undefined,
      session_id: "session-1",
      source: "pi",
    });

    expect(payload).toEqual({
      message: "Task complete",
      title: "Pi Notification",
      voice_enabled: true,
      session_id: "session-1",
      source: "pi",
    });
  });

  test("passes speak_mode through when adapters set density", () => {
    const payload = normalizeNotifyPayload({
      message: "Want me to go ahead?",
      speak_mode: "consult",
      source: "pi",
    });
    expect(payload.speak_mode).toBe("consult");
  });
});
