import { describe, expect, test } from "bun:test";
import { extractVoiceLineFromMessage, extractVoiceLineFromText, isValidVoiceLine, stableMessageKey } from "../../../adapters/pi/voice-line";

describe("Pi voice line extraction", () => {
  test("extracts the final voice line from assistant text", () => {
    expect(extractVoiceLineFromText("Work done.\n🗣️ Refactor complete.")).toBe("Refactor complete.");
  });

  test("uses the final voice line when multiple are present", () => {
    const text = "🗣️ Earlier line.\nDetails\n🗣️ Final line.";
    expect(extractVoiceLineFromText(text)).toBe("Final line.");
  });

  test("returns null when no voice line is present", () => {
    expect(extractVoiceLineFromText("No spoken line here.")).toBeNull();
  });

  test("strips a leading persona name so it is not spoken aloud", () => {
    expect(extractVoiceLineFromText("🗣️ Atlas: shipped it")).toBe("shipped it");
    expect(extractVoiceLineFromText("🗣️ Themis: dispatched the worker")).toBe("dispatched the worker");
  });

  test("keeps nameless voice lines unchanged (back-compat)", () => {
    expect(extractVoiceLineFromText("🗣️ shipped the fix")).toBe("shipped the fix");
    expect(extractVoiceLineFromText("🗣️ Refactor complete.")).toBe("Refactor complete.");
  });

  test("extracts text blocks from assistant messages", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Summary\n🗣️ Tests passed." }],
    };
    expect(extractVoiceLineFromMessage(message)).toBe("Tests passed.");
  });

  test("rejects generic completion lines even with punctuation", () => {
    expect(isValidVoiceLine("Done.")).toBe(false);
    expect(isValidVoiceLine("Ready!")).toBe(false);
    expect(isValidVoiceLine("Okay…")).toBe(false);
    expect(extractVoiceLineFromText("🗣️ Done.")).toBeNull();
  });

  test("stable keys are deterministic per session and line", () => {
    expect(stableMessageKey("s1", "Tests passed.")).toBe(stableMessageKey("s1", "Tests passed."));
    expect(stableMessageKey("s1", "Tests passed.")).not.toBe(stableMessageKey("s2", "Tests passed."));
  });

  test("stable keys include message identity when provided", () => {
    const line = "Tests passed.";
    const first = { message: { role: "assistant", id: "m1", content: `Summary A\n🗣️ ${line}` } };
    const second = { message: { role: "assistant", id: "m2", content: `Summary B\n🗣️ ${line}` } };

    expect(stableMessageKey("s1", first, line)).not.toBe(stableMessageKey("s1", second, line));
  });
});
