import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  REPLAY_DEFAULT_N,
  REPLAY_MAX_N,
  SPEAK_HISTORY_CAPACITY,
  clearSpeakHistory,
  lastSpokenLines,
  parseReplayBody,
  recordSpokenLine,
  spokenLineCount,
  type SpokenLine,
} from "../../core/speak-history";

function line(message: string): SpokenLine {
  return { message, voiceId: "kai", voiceSettings: { speed: 1 }, speakMode: "announce" };
}

beforeEach(() => {
  // The ring is process-global (same singleton the daemon records into).
  clearSpeakHistory();
});

afterEach(() => {
  clearSpeakHistory();
});

describe("speak-history ring", () => {
  test("records in order and returns the last N oldest-first", () => {
    recordSpokenLine(line("one"));
    recordSpokenLine(line("two"));
    recordSpokenLine(line("three"));
    expect(spokenLineCount()).toBe(3);
    expect(lastSpokenLines(1).map((l) => l.message)).toEqual(["three"]);
    expect(lastSpokenLines(2).map((l) => l.message)).toEqual(["two", "three"]);
    expect(lastSpokenLines(3).map((l) => l.message)).toEqual(["one", "two", "three"]);
  });

  test("N larger than available returns everything, oldest-first", () => {
    recordSpokenLine(line("only"));
    expect(lastSpokenLines(REPLAY_MAX_N).map((l) => l.message)).toEqual(["only"]);
  });

  test("capacity drops the oldest", () => {
    for (let i = 0; i < SPEAK_HISTORY_CAPACITY + 3; i++) {
      recordSpokenLine(line(`m${i}`));
    }
    expect(spokenLineCount()).toBe(SPEAK_HISTORY_CAPACITY);
    const kept = lastSpokenLines(SPEAK_HISTORY_CAPACITY).map((l) => l.message);
    expect(kept[0]).toBe("m3");
    expect(kept.at(-1)).toBe(`m${SPEAK_HISTORY_CAPACITY + 2}`);
  });

  test("clearSpeakHistory empties the ring", () => {
    recordSpokenLine(line("gone"));
    clearSpeakHistory();
    expect(spokenLineCount()).toBe(0);
    expect(lastSpokenLines(1)).toEqual([]);
  });
});

describe("parseReplayBody", () => {
  test("empty body and omitted n default to 1", () => {
    expect(parseReplayBody("")).toEqual({ ok: true, n: REPLAY_DEFAULT_N });
    expect(parseReplayBody("   ")).toEqual({ ok: true, n: REPLAY_DEFAULT_N });
    expect(parseReplayBody("{}")).toEqual({ ok: true, n: REPLAY_DEFAULT_N });
  });

  test("accepts 1..max", () => {
    expect(parseReplayBody('{"n":1}')).toEqual({ ok: true, n: 1 });
    expect(parseReplayBody(`{"n":${REPLAY_MAX_N}}`)).toEqual({ ok: true, n: REPLAY_MAX_N });
  });

  test("rejects abusive or non-integer n", () => {
    for (const body of ['{"n":0}', '{"n":11}', '{"n":-1}', '{"n":1.5}', '{"n":null}', '{"n":"3"}']) {
      const parsed = parseReplayBody(body);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("n must be an integer");
    }
  });

  test("rejects malformed JSON", () => {
    expect(parseReplayBody("{nope")).toEqual({ ok: false, message: "Invalid JSON body" });
    expect(parseReplayBody("[]")).toEqual({ ok: false, message: "Invalid body" });
  });
});
