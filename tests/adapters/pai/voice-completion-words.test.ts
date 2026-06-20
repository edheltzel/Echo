import { describe, expect, test } from "bun:test";
import {
  extractVoiceCompletion,
  parseFinalVoiceLine,
} from "../../../adapters/pai/hooks/lib/TranscriptParser";
import { resolvePersonaKey } from "../../../adapters/pai/hooks/handlers/VoiceNotification";

const FENCE = "```";

describe("extractVoiceCompletion — a persona speaks its OWN 🗣️ words (#31)", () => {
  test("persona line → the persona's own words, not a fallback summary", () => {
    expect(
      extractVoiceCompletion("Status update.\n🗣️ Themis: Themis here. Let's coordinate."),
    ).toBe("Themis here. Let's coordinate.");
  });

  test("Atlas line → unchanged behavior (regression guard)", () => {
    expect(extractVoiceCompletion("Fixed it.\n🗣️ Atlas: done.")).toBe("done.");
  });

  test("hyphenated persona key → its own words", () => {
    expect(extractVoiceCompletion("🗣️ qa-tester: verifying the flow.")).toBe(
      "verifying the flow.",
    );
  });

  test("bold persona name → words with no stray markdown", () => {
    expect(extractVoiceCompletion("🗣️ **Themis:** dispatching.")).toBe("dispatching.");
  });

  test("bold Atlas name → unchanged words (no stray closing **)", () => {
    expect(extractVoiceCompletion("🗣️ **Atlas:** shipped.")).toBe("shipped.");
  });

  test("no 🗣️ line → '' (silence preserved)", () => {
    expect(extractVoiceCompletion("Just some prose with no voice line.")).toBe("");
  });

  test("a 🗣️ inside a code fence is ignored → '' (only the final real line counts)", () => {
    const text = `The format is:\n${FENCE}\n🗣️ Themis: example\n${FENCE}\nThat's the change.`;
    expect(extractVoiceCompletion(text)).toBe("");
  });

  test("an earlier fenced demo does not steal words from the real final line", () => {
    const text = `Reference:\n${FENCE}\n🗣️ Engineer: example\n${FENCE}\n🗣️ Themis: dispatching for real.`;
    expect(extractVoiceCompletion(text)).toBe("dispatching for real.");
  });

  test("an indented 🗣️ demo is ignored → ''", () => {
    expect(extractVoiceCompletion("Format:\n\n    🗣️ Themis: demo")).toBe("");
  });

  test("CRLF voice line → words with no carriage return", () => {
    const words = extractVoiceCompletion("Working on it.\r\n🗣️ Themis: coordinating.\r\n");
    expect(words).toBe("coordinating.");
    expect(words).not.toContain("\r");
  });

  test("uses the LAST voice line (the voice line sits at the end)", () => {
    const text = "🗣️ Themis: example mentioned earlier.\nmore work\n🗣️ Atlas: shipped the fix.";
    expect(extractVoiceCompletion(text)).toBe("shipped the fix.");
  });

  test("strips a leading [AGENT:x] tag (legacy cleanup preserved)", () => {
    expect(extractVoiceCompletion("🗣️ Atlas: [AGENT:forge] built it.")).toBe("built it.");
  });

  test("system-reminder tags are stripped before parsing", () => {
    const text = "🗣️ Themis: real words.\n<system-reminder>noise</system-reminder>";
    expect(extractVoiceCompletion(text)).toBe("real words.");
  });

  test("🎯 COMPLETED: marker still works as a fallback when there is no voice line", () => {
    expect(extractVoiceCompletion("Work done.\n🎯 COMPLETED: all green.")).toBe("all green.");
  });
});

describe("voice and words never disagree — both consume parseFinalVoiceLine", () => {
  test("persona turn: resolved voice key and spoken words come from the same line", () => {
    const text = "Status.\n🗣️ Themis: coordinating the next worker.";
    expect(resolvePersonaKey(text, "Atlas")).toBe("themis");
    expect(extractVoiceCompletion(text)).toBe("coordinating the next worker.");
  });

  test("Atlas turn: DA path (null persona) and its own words agree", () => {
    const text = "Fixed the bug.\n🗣️ Atlas: shipped the fix.";
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
    expect(extractVoiceCompletion(text)).toBe("shipped the fix.");
  });

  test("fenced demo in an Atlas turn: no persona voice AND no persona words", () => {
    const text = `Example:\n${FENCE}\n🗣️ Themis: example line\n${FENCE}\nDocumented.`;
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
    expect(extractVoiceCompletion(text)).toBe("");
  });
});

describe("parseFinalVoiceLine — the shared canonical parse", () => {
  test("returns the original-case name and trimmed words", () => {
    expect(parseFinalVoiceLine("🗣️ Themis: go now.")).toEqual({
      name: "Themis",
      words: "go now.",
    });
  });

  test("empty input → null", () => {
    expect(parseFinalVoiceLine("")).toBeNull();
  });

  test("non-voice final line → null", () => {
    expect(parseFinalVoiceLine("just prose")).toBeNull();
  });
});
