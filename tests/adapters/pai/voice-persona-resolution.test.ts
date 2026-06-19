import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePersonaKey, selectVoice } from "../../../adapters/pai/hooks/handlers/VoiceNotification";
import { parseTranscript } from "../../../adapters/pai/hooks/lib/TranscriptParser";
import type { Identity } from "../../../adapters/pai/hooks/lib/identity";
import type { ParsedTranscript } from "../../../adapters/pai/hooks/lib/TranscriptParser";

// Atlas (DA) identity fixture — mirrors the hardcoded path the bug degraded to Ava.
const ATLAS: Identity = {
  name: "Atlas",
  fullName: "Atlas",
  displayName: "Atlas",
  mainDAVoiceID: "AyCt0WmAXUcPJR11zeeP",
  color: "#3B82F6",
  voice: { stability: 0.5, similarity_boost: 0.75, style: 0.0, speed: 1.0, use_speaker_boost: true },
};

function parsedWith(currentResponseText: string, lastMessage = ""): ParsedTranscript {
  return {
    raw: "",
    lastMessage,
    currentResponseText,
    voiceCompletion: "",
    plainCompletion: "",
    structured: {},
    responseState: "completed",
  };
}

describe("resolvePersonaKey — persona detection from the 🗣️ speaker tag", () => {
  test("returns the lowercase persona key for a main-session persona", () => {
    expect(resolvePersonaKey("Status update.\n🗣️ Themis: coordinating the next worker.", "Atlas")).toBe("themis");
  });

  test("handles a bold speaker tag", () => {
    expect(resolvePersonaKey("🗣️ **Themis:** dispatching.", "Atlas")).toBe("themis");
  });

  test("handles hyphenated persona keys (e.g. qa-tester)", () => {
    expect(resolvePersonaKey("🗣️ qa-tester: verifying the flow.", "Atlas")).toBe("qa-tester");
  });

  test("returns null for the DA's own line (Atlas path)", () => {
    expect(resolvePersonaKey("🗣️ Atlas: task complete.", "Atlas")).toBeNull();
  });

  test("DA match is case-insensitive", () => {
    expect(resolvePersonaKey("🗣️ ATLAS: done.", "Atlas")).toBeNull();
  });

  test("returns null when no speaker tag is present", () => {
    expect(resolvePersonaKey("Just some prose with no voice line.", "Atlas")).toBeNull();
  });

  test("uses the LAST speaker tag (the voice line sits at the end)", () => {
    const text = "🗣️ Atlas: example mentioned earlier.\nmore work\n🗣️ Themis: final line.";
    expect(resolvePersonaKey(text, "Atlas")).toBe("themis");
  });

  test("a trailing Atlas line reverts to the DA path even after a persona mention", () => {
    const text = "discussing 🗣️ Themis: as an example\n🗣️ Atlas: actually Atlas spoke last.";
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
  });
});

describe("selectVoice — what the Stop-hook path sends to the voice server", () => {
  test("persona active → sends the resolvable persona key, NOT the hardcoded mainDAVoiceID", () => {
    const sel = selectVoice(parsedWith("🗣️ Themis: coordinating."), ATLAS);
    expect(sel.voiceId).toBe("themis");
    expect(sel.voiceId).not.toBe(ATLAS.mainDAVoiceID);
    // Persona delegates prosody to the daemon's per-agent config.
    expect(sel.voiceSettings).toBeUndefined();
    expect(sel.speaker).toBe("themis");
  });

  test("Atlas / no persona → byte-for-byte the previous DA voice path (regression guard)", () => {
    const sel = selectVoice(parsedWith("🗣️ Atlas: task complete."), ATLAS);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.voiceSettings).toBe(ATLAS.voice);
    expect(sel.speaker).toBe("Atlas");
  });

  test("no voice line at all → DA voice path (unchanged)", () => {
    const sel = selectVoice(parsedWith("Plain response, no tag."), ATLAS);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.speaker).toBe("Atlas");
  });

  test("falls back to lastMessage when currentResponseText is empty", () => {
    const sel = selectVoice(parsedWith("", "🗣️ Engineer: building it."), ATLAS);
    expect(sel.voiceId).toBe("engineer");
  });
});

describe("resolved persona keys are resolvable by the daemon (voices.json)", () => {
  // Ties resolution to daemon resolvability: a persona key the hook sends must be
  // a real agents entry in core/voices.json (getVoiceMapping resolves it).
  const voices = JSON.parse(readFileSync("core/voices.json", "utf8")) as { agents: Record<string, unknown> };

  test("themis resolves to a configured agent voice", () => {
    const key = resolvePersonaKey("🗣️ Themis: go.", "Atlas");
    expect(key).not.toBeNull();
    expect(voices.agents[key!]).toBeDefined();
  });
});

describe("integration — full Stop-hook chain (transcript → parse → selectVoice)", () => {
  // Proves currentResponseText actually carries the 🗣️ tag through real parsing,
  // not just hand-built ParsedTranscript fixtures. No mocks.
  function withTranscript(lines: object[], fn: (path: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "atlas-transcript-"));
    try {
      const path = join(root, "transcript.jsonl");
      writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      fn(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a persona turn resolves to the persona voice end-to-end", () => {
    withTranscript(
      [
        { type: "user", message: { content: "do the thing" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Working on it.\n🗣️ Themis: dispatching the worker now." }] } },
      ],
      (path) => {
        const sel = selectVoice(parseTranscript(path), ATLAS);
        expect(sel.voiceId).toBe("themis");
        expect(sel.voiceId).not.toBe(ATLAS.mainDAVoiceID);
      },
    );
  });

  test("an Atlas turn resolves to the DA voice end-to-end (regression guard)", () => {
    withTranscript(
      [
        { type: "user", message: { content: "do the thing" } },
        { type: "assistant", message: { content: [{ type: "text", text: "Fixed the bug.\n🗣️ Atlas: shipped the fix." }] } },
      ],
      (path) => {
        const sel = selectVoice(parseTranscript(path), ATLAS);
        expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
      },
    );
  });
});
