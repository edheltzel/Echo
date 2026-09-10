import { describe, expect, test } from "bun:test";
import {
  applySpeakModeSpeed,
  BRIEF_CHAR_THRESHOLD,
  detectSpeakMode,
  parseSpeakMode,
  SPEAK_MODE_SPEED,
  voiceEnabledForSpeakMode,
  withDetectedSpeakMode,
} from "../../shared/speak-mode.ts";

describe("parseSpeakMode", () => {
  test("omitted, null, and empty keep today's density", () => {
    expect(parseSpeakMode(undefined)).toEqual({ ok: true, mode: undefined });
    expect(parseSpeakMode(null)).toEqual({ ok: true, mode: undefined });
    expect(parseSpeakMode("")).toEqual({ ok: true, mode: undefined });
  });

  test("accepts the four notify-density names, case-insensitive", () => {
    expect(parseSpeakMode("announce")).toEqual({ ok: true, mode: "announce" });
    expect(parseSpeakMode("Brief")).toEqual({ ok: true, mode: "brief" });
    expect(parseSpeakMode(" CONSULT ")).toEqual({ ok: true, mode: "consult" });
    expect(parseSpeakMode("think")).toEqual({ ok: true, mode: "think" });
  });

  test("rejects converse, auto, and junk (not a fifth TTS taxonomy)", () => {
    expect(parseSpeakMode("converse")).toEqual({ ok: false });
    expect(parseSpeakMode("auto")).toEqual({ ok: false });
    expect(parseSpeakMode("whisper")).toEqual({ ok: false });
    expect(parseSpeakMode(1)).toEqual({ ok: false });
  });
});

describe("detectSpeakMode", () => {
  test("short completion lines are announce", () => {
    expect(detectSpeakMode("Task complete.")).toBe("announce");
    expect(detectSpeakMode("Added the adapter.")).toBe("announce");
  });

  test("questions and about-to checkpoints are consult", () => {
    expect(detectSpeakMode("Want me to go ahead?")).toBe("consult");
    expect(detectSpeakMode("I am about to push to main.")).toBe("consult");
  });

  test("long explanations are brief", () => {
    expect(detectSpeakMode("x".repeat(BRIEF_CHAR_THRESHOLD))).toBe("announce");
    expect(detectSpeakMode("x".repeat(BRIEF_CHAR_THRESHOLD + 1))).toBe("brief");
  });

  test("never infers think", () => {
    expect(detectSpeakMode("insight: the auth flow races")).toBe("announce");
    expect(detectSpeakMode("note: skip the flaky test")).toBe("announce");
    expect(detectSpeakMode("TODO: check the lease cap")).toBe("announce");
  });
});

describe("applySpeakModeSpeed", () => {
  test("multiplies the resolved persona speed", () => {
    expect(applySpeakModeSpeed(0.92, "announce")).toBeCloseTo(1.012);
    expect(applySpeakModeSpeed(0.92, "brief")).toBeCloseTo(0.828);
    expect(applySpeakModeSpeed(0.92, "consult")).toBeCloseTo(0.966);
  });

  test("omitted and think leave speed alone", () => {
    expect(applySpeakModeSpeed(0.92, undefined)).toBe(0.92);
    expect(applySpeakModeSpeed(0.92, "think")).toBe(0.92);
  });

  test("pins the VoiceLayer notify-density table", () => {
    expect(SPEAK_MODE_SPEED).toEqual({ announce: 1.10, brief: 0.90, consult: 1.05 });
  });
});

describe("voiceEnabledForSpeakMode", () => {
  test("think is silent even when voice is on", () => {
    expect(voiceEnabledForSpeakMode("think", true)).toBe(false);
    expect(voiceEnabledForSpeakMode("announce", true)).toBe(true);
    expect(voiceEnabledForSpeakMode(undefined, false)).toBe(false);
  });
});

describe("withDetectedSpeakMode", () => {
  test("fills announce on a short line when omitted", () => {
    expect(withDetectedSpeakMode({ message: "Shipped." }).speak_mode).toBe("announce");
  });

  test("keeps an explicit think", () => {
    expect(withDetectedSpeakMode({ message: "insight", speak_mode: "think" }).speak_mode)
      .toBe("think");
  });
});
