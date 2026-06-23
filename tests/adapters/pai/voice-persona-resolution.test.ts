import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVoicePayload,
  clearAgentKeysCache,
  loadKnownAgentKeys,
  resolvePersonaKey,
  selectVoice,
} from "../../../adapters/pai/hooks/handlers/VoiceNotification";
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

// Explicit known-agents set so selectVoice tests don't depend on voices.json on disk.
const KNOWN = new Set(["themis", "engineer", "qa-tester"]);

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

  test("normalizes casing to a lowercase key", () => {
    expect(resolvePersonaKey("🗣️ THEMIS: go.", "Atlas")).toBe("themis");
    expect(resolvePersonaKey("🗣️ Themis: go.", "Atlas")).toBe("themis");
  });

  test("tolerates a missing space after the emoji", () => {
    expect(resolvePersonaKey("🗣️Themis: go.", "Atlas")).toBe("themis");
  });

  test("an indented 🗣️ line is NOT a voice line (must be column 0)", () => {
    // A genuine PAI voice line is never indented; indentation signals a demo/quote.
    expect(resolvePersonaKey("- summary\n  🗣️ Themis: go.", "Atlas")).toBeNull();
  });

  test("returns null for an empty/malformed tag", () => {
    expect(resolvePersonaKey("🗣️ : nothing here", "Atlas")).toBeNull();
    expect(resolvePersonaKey("🗣️ 123: digits first", "Atlas")).toBeNull();
  });

  test("does NOT match an inline mention/quote (must begin its own line)", () => {
    // An Atlas turn that merely references a tag inside a sentence must not flip voice.
    expect(resolvePersonaKey("I will brief 🗣️ Themis: do the thing — inline mention.", "Atlas")).toBeNull();
    expect(resolvePersonaKey("The hook reads the `🗣️ Themis:` tag from the response.", "Atlas")).toBeNull();
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

describe("resolvePersonaKey — final-line anchoring (code fences / demos must not win)", () => {
  const FENCE = "```";

  test("a 🗣️ tag inside a code fence does NOT win (Atlas turn, no trailing voice line)", () => {
    // RedTeam round-2 repro: docs/AGENTS.md routinely demonstrate the voice format.
    const text = `The format is:\n${FENCE}\n🗣️ Themis: example\n${FENCE}\nThat's the change.`;
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
  });

  test("a fenced known-persona demo while the real speaker is Atlas → null", () => {
    const text = `Here is how Themis speaks:\n${FENCE}\n🗣️ Engineer: building it\n${FENCE}\n🗣️ Atlas: documented it.`;
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
  });

  test("a turn ending with a fenced persona line (closing fence is the last line) → null", () => {
    const text = `Example:\n${FENCE}\n🗣️ Themis: example\n${FENCE}`;
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
  });

  test("a turn ending with an UNCLOSED fenced persona line → null", () => {
    const text = `Example:\n${FENCE}\n🗣️ Themis: example`;
    expect(resolvePersonaKey(text, "Atlas")).toBeNull();
  });

  test("a real persona voice line as the final line still wins (with an earlier fenced demo)", () => {
    const text = `Reference:\n${FENCE}\n🗣️ Engineer: example\n${FENCE}\n🗣️ Themis: dispatching for real.`;
    expect(resolvePersonaKey(text, "Atlas")).toBe("themis");
  });

  test("a 4-space indented 🗣️ demo does NOT win", () => {
    expect(resolvePersonaKey("Format:\n\n    🗣️ Themis: demo", "Atlas")).toBeNull();
  });

  test("a tab-indented 🗣️ demo does NOT win", () => {
    expect(resolvePersonaKey("Format:\n\n\t🗣️ Themis: demo", "Atlas")).toBeNull();
  });

  test("a ~~~ tilde-fenced demo does NOT win (closed and unclosed)", () => {
    const TILDE = "~~~";
    expect(resolvePersonaKey(`Example:\n${TILDE}\n🗣️ Themis: x\n${TILDE}\ndone.`, "Atlas")).toBeNull();
    expect(resolvePersonaKey(`Example:\n${TILDE}\n🗣️ Themis: x`, "Atlas")).toBeNull();
  });

  test("inline ``` runs (not a fence delimiter) do NOT eat a real final voice line", () => {
    // Regression for the greedy string-strip: a stray inline ``` must not demote
    // the real persona voice line on the final line.
    const text = `inline ${FENCE}code${FENCE} and ${FENCE} stray\n🗣️ Themis: real`;
    expect(resolvePersonaKey(text, "Atlas")).toBe("themis");
  });

  test("CRLF voice line resolves cleanly with no carriage return in the key", () => {
    const key = resolvePersonaKey("Working on it.\r\n🗣️ Themis: x\r\n", "Atlas");
    expect(key).toBe("themis");
    expect(key).not.toContain("\r");
  });

  test("nested/mixed fences: real line after a closed outer ~~~ wins; a line inside it stays DA", () => {
    const TILDE = "~~~";
    // Inner ``` fence nested in an outer ~~~ fence, then a real persona line after close.
    const real = `Reference:\n${TILDE}\n${FENCE}\n🗣️ Engineer: demo\n${FENCE}\n${TILDE}\n🗣️ Themis: real`;
    expect(resolvePersonaKey(real, "Atlas")).toBe("themis");
    // Same nesting but the only voice line is inside the outer fence → DA.
    const inside = `Demo:\n${TILDE}\n${FENCE}\n🗣️ Engineer: demo\n${FENCE}\n${TILDE}`;
    expect(resolvePersonaKey(inside, "Atlas")).toBeNull();
  });
});

describe("selectVoice — what the Stop-hook path sends to the voice server", () => {
  test("known persona → sends the resolvable persona key, NOT the hardcoded mainDAVoiceID", () => {
    const sel = selectVoice(parsedWith("🗣️ Themis: coordinating."), ATLAS, KNOWN);
    expect(sel.voiceId).toBe("themis");
    expect(sel.voiceId).not.toBe(ATLAS.mainDAVoiceID);
    // Persona delegates prosody to the daemon's per-agent config.
    expect(sel.voiceSettings).toBeUndefined();
    // #33: title shows the display name (original-case tag), not the lowercase key.
    expect(sel.speaker).toBe("Themis");
  });

  test("#33: speaker is the original-case display name while voiceId stays the lowercase key", () => {
    const sel = selectVoice(parsedWith("🗣️ Themis: coordinating."), ATLAS, KNOWN);
    // voice_id must remain the lowercase key the daemon resolves — unchanged.
    expect(sel.voiceId).toBe("themis");
    // title source is the display name from the tag, not the resolved key.
    expect(sel.speaker).toBe("Themis");
    expect(sel.speaker).not.toBe("themis");
  });

  test("#33 casing edge: an odd-case persona tag resolves voice correctly; title reflects the tag's case", () => {
    // No canonical display-name field exists in voices.json, so the original-case
    // tag IS the display source: voice still resolves (lowercased key), and the
    // title mirrors exactly what was written.
    const sel = selectVoice(parsedWith("🗣️ THEMIS: go."), ATLAS, KNOWN);
    expect(sel.voiceId).toBe("themis");
    expect(sel.speaker).toBe("THEMIS");
  });

  test("UNKNOWN persona key → DA voice fallback, never an unresolvable key (would be Ava)", () => {
    // "Gandalf" is not in voices.json — sending it would resolve to null → daemon
    // default (Ava) = the exact #27 bug. selectVoice must fall back to the DA voice.
    const sel = selectVoice(parsedWith("🗣️ Gandalf: you shall not pass."), ATLAS, KNOWN);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.voiceSettings).toBe(ATLAS.voice);
    expect(sel.speaker).toBe("Atlas");
  });

  test("inline/quoted tag in an Atlas turn → DA voice (no hijack)", () => {
    const text = "The hook reads the `🗣️ Themis:` tag inline. No real voice line here.";
    const sel = selectVoice(parsedWith(text), ATLAS, KNOWN);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.speaker).toBe("Atlas");
  });

  test("fenced known-persona demo in an Atlas turn → DA voice (the configured-key gate can't catch this; anchoring must)", () => {
    const text = "Example of the format:\n```\n🗣️ Themis: example line\n```\nThat's documented.";
    const sel = selectVoice(parsedWith(text), ATLAS, KNOWN);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.speaker).toBe("Atlas");
  });

  test("Atlas / no persona → byte-for-byte the previous DA voice path (regression guard)", () => {
    const sel = selectVoice(parsedWith("🗣️ Atlas: task complete."), ATLAS, KNOWN);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.voiceSettings).toBe(ATLAS.voice);
    expect(sel.speaker).toBe("Atlas");
  });

  test("no voice line at all → DA voice path (unchanged)", () => {
    const sel = selectVoice(parsedWith("Plain response, no tag."), ATLAS, KNOWN);
    expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    expect(sel.speaker).toBe("Atlas");
  });

  test("falls back to lastMessage when currentResponseText is empty", () => {
    const sel = selectVoice(parsedWith("", "🗣️ Engineer: building it."), ATLAS, KNOWN);
    expect(sel.voiceId).toBe("engineer");
  });
});

describe("buildVoicePayload — the exact payload sent to the voice server", () => {
  test("persona selection → lowercase name key for voice, display-name title, no Atlas prosody", () => {
    // Mirrors what selectVoice produces post-#33: voice_id is the resolvable
    // lowercase key, title carries the original-case display name.
    const payload = buildVoicePayload("Dispatching the worker.", "sess-1", { voiceId: "themis", speaker: "Themis" });
    expect(payload.voice_id).toBe("themis");
    expect(payload.title).toBe("Themis says");
    expect(payload.voice_settings).toBeUndefined();
    expect(payload.voice_enabled).toBe(true);
    expect(payload.source).toBe("pai");
    expect(payload.session_id).toBe("sess-1");
    expect(payload.message).toBe("Dispatching the worker.");
  });

  test("DA selection → mainDAVoiceID, Atlas title, prosody applied", () => {
    const payload = buildVoicePayload("Shipped the fix.", "sess-2", {
      voiceId: ATLAS.mainDAVoiceID,
      voiceSettings: ATLAS.voice,
      speaker: ATLAS.name,
    });
    expect(payload.voice_id).toBe(ATLAS.mainDAVoiceID);
    expect(payload.title).toBe("Atlas says");
    expect(payload.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      speed: 1.0,
      use_speaker_boost: true,
    });
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

describe("loadKnownAgentKeys — default loader is crash-safe", () => {
  function withVoicesPath(value: string | undefined, fn: () => void) {
    const prev = process.env.VOICES_PATH;
    if (value === undefined) delete process.env.VOICES_PATH;
    else process.env.VOICES_PATH = value;
    clearAgentKeysCache();
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.VOICES_PATH;
      else process.env.VOICES_PATH = prev;
      clearAgentKeysCache();
    }
  }

  test("missing voices.json → empty set, no throw → selectVoice falls back to DA", () => {
    withVoicesPath("/nonexistent/path/voices.json", () => {
      expect(() => loadKnownAgentKeys()).not.toThrow();
      expect(loadKnownAgentKeys().size).toBe(0);
      // Default loader (no explicit knownAgents) → unknown → DA voice.
      const sel = selectVoice(parsedWith("🗣️ Themis: go."), ATLAS);
      expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
    });
  });

  test("malformed voices.json → empty set, no throw → selectVoice falls back to DA", () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-bad-voices-"));
    try {
      const bad = join(root, "voices.json");
      writeFileSync(bad, "{ not valid json ");
      withVoicesPath(bad, () => {
        expect(() => loadKnownAgentKeys()).not.toThrow();
        expect(loadKnownAgentKeys().size).toBe(0);
        const sel = selectVoice(parsedWith("🗣️ Themis: go."), ATLAS);
        expect(sel.voiceId).toBe(ATLAS.mainDAVoiceID);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
