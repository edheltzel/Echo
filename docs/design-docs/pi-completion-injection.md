---
status: Shipped
last_reviewed: 2026-06-23
issue: 15
---

# Pi spoken-completion parity via hook injection (#15)

> **Status: Shipped.** Delivered in PR #46 (squash-merged to `dev`). This doc is the
> original design/scout report, preserved for rationale. The shipped behavior is summarized
> in [`../adapters.md`](../adapters.md) → *Pi adapter — per-turn completions* and in
> [`../voices.md`](../voices.md). Where this doc and the code disagree, the code and
> [`../../AGENTS.md`](../../AGENTS.md) win.

**Original author:** Explorer (reporting to Themis) · **Design date:** 2026-06-23
**Decision enabled (Ed's call):** make Pi speak a per-turn completion by **injecting the
PAI-style `🗣️` spoken-completion convention into Pi's system prompt**, mirroring the Claude
Code hook path — so Pi "speaks like Atlas." (We are NOT using the "extract a line without a
tag" approach.)

**Headline:** ✅ **The injection seam exists.** Pi's `before_agent_start` event lets an
extension read the live system prompt and **return a replacement** (`{ systemPrompt?: string
}`, chained across extensions). That is exactly the hook we need. No daemon change required.
One small, required change to `voice-line.ts` (strip an optional `<Name>:` prefix so the
persona name isn't spoken aloud).

---

## 1. Root-cause confirmation (#15)

Confirmed by reading the adapter (grounded via codegraph `codegraph_explore` on
`atlasVoicePiAdapter`):

`adapters/pi/index.ts` (`atlasVoicePiAdapter`) subscribes to four lifecycle events:

- `session_start` → speaks `config.catchphrase` (a **static string**, needs no tag) →
  **greeting works.**
- `message_end` and `turn_end` → both call `speakAssistantCompletion`, which calls
  `extractVoiceLineFromMessage(message)`.
- `session_shutdown` → clears dedupe state.

`extractVoiceLineFromMessage` → `getAssistantText` → `extractVoiceLineFromText`
(`adapters/pi/voice-line.ts`) **only returns a value for lines beginning with `🗣️`/`🗣`**.
Returns `null` otherwise.

**Net:** Pi's own models are never told to emit a `🗣️` line (no system-prompt convention
instructs them), so `extractVoiceLineFromText` returns `null` on every real completion and
`speakAssistantCompletion` silently no-ops. The greeting fires because it bypasses extraction
entirely. **`before_agent_start` was not subscribed at all** — so nothing injected the
convention. This matched the reported symptom: greeting audible, completions silent.

## 2. The injection seam (the key finding)

**Yes, Pi supports system-prompt injection.** The mechanism is `before_agent_start`:

1. The handler receives the **current** assembled system prompt as `event.systemPrompt:
   string`.
2. The handler **returns** `{ systemPrompt: <modified string> }` to **replace** it for that
   turn. The docs state the return is *"chained across extensions"*, so appending (not
   clobbering) is the correct pattern: `return { systemPrompt: event.systemPrompt + "\n\n" +
   INSTRUCTION }`.

This is the structural equivalent of PAI's "global response format" convention living in the
system prompt — except contributed at runtime by the extension instead of by a static config
file.

**Version sensitivity:** issue #575's *original* text said `before_agent_start` *"currently
only allows appending via `systemPromptAppend`."* The issue is now **closed** and the current
`main` docs document the full `{ systemPrompt?: string }` replace return. The repo pins
`peerDependencies["@earendil-works/pi-coding-agent"]: ">=0.78.0"`. The shipped code uses the
return form and **feature-detects** so it degrades safely on an older runtime.

> **Source:** Pi extension docs —
> https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md;
> issue #575 — https://github.com/earendil-works/pi/issues/575; package —
> https://www.npmjs.com/package/@earendil-works/pi-coding-agent

## 3. PAI mirror (how Claude Code already does this)

- **Getting the tag in:** PAI's global response-format convention instructs every response
  to end with a `🗣️ <Name>: <8–16 word summary>` line. The model emits it because the system
  prompt tells it to. **This is the exact thing replicated in Pi via `before_agent_start`.**
- **Consuming the tag:** the PAI **Stop hook** `adapters/pai/hooks/VoiceCompletion.hook.ts`
  runs each turn. `parseFinalVoiceLine` (`adapters/pai/hooks/lib/TranscriptParser.ts`) reads
  the trailing `🗣️ <Name>:` tag into `{name, words}`; `handleVoice` uses the **name** to
  resolve voice/persona and `extractVoiceCompletion` yields the **words**.

Pi parity = inject the same convention (step 1) and let the **existing**
`message_end`/`turn_end` → `extractVoiceLineFromMessage` path play the role of the Stop hook
(step 2).

## 4. Shipped design (files + changes)

### 4.1 Subscribe to `before_agent_start` and inject the convention — `adapters/pi/index.ts`

A `before_agent_start` handler appends the voice-line instruction to `event.systemPrompt`,
using the configured persona name (`ATLAS_VOICE_PERSONA_NAME`, default `"Atlas"`), gated on
`config.speakCompletions` AND `shouldSuppressVoice(...)` so headless/`--mode json` subagents
(`hasUI === false`) neither emit the tag nor speak. Feature-detects `event.systemPrompt` and
no-ops if absent (older runtime → degrade safely).

### 4.2 Stop the persona name from being spoken — `adapters/pi/voice-line.ts` (REQUIRED)

The one non-obvious gotcha. The original `extractVoiceLineFromText` only stripped the `🗣️`
emoji and a single leading `:`/`-`. For `🗣️ Atlas: Tests passed.` it would return
**`"Atlas: Tests passed."`** — speaking the persona name aloud. The fix mirrors PAI's
`parseFinalVoiceLine` by stripping an optional leading `<Name>:` token after the emoji,
keeping backward compatibility (lines without a name pass through unchanged).

### 4.3 What did NOT change

- **Consumption path:** `message_end`/`turn_end` → `speakAssistantCompletion` →
  `extractVoiceLineFromMessage` already did the right thing once the tag is present.
- **`source` / `session_id`:** `buildPiNotifyPayload` already sets `source: "pi"` and
  `session_id` from `resolveSessionId(ctx)`.
- **Subagent / child suppression:** `shouldSuppressVoice` already suppresses speaking when
  `hasUI === false` or `mode` is `json`/`print`.
- **Daemon:** **no change** — the daemon already resolves a request `voice_id` name key to a
  provider voice.
- **Dedupe:** unchanged — `stableMessageKey` + the 5s window collapse the
  `message_end`+`turn_end` double-fire.

## 5. Risks / unknowns (at design time)

1. **Model compliance (medium).** Pi may run smaller/non-Claude models that won't reliably
   end every turn with the tag. Failure mode is *graceful* — `extractVoiceLineFromText`
   returns `null`, so a missing tag just means "no voice this turn," never an error.
2. **SDK version of the `systemPrompt` return (medium).** Mitigated by feature-detection +
   `systemPromptAppend` fallback.
3. **Persona-name leak (high if missed, fully mitigated by §4.2).**
4. **Subagent transcript pollution (low).** Prevented by the §4.1 suppression gate.
5. **Chaining etiquette (low).** Always append to `event.systemPrompt`; never return a bare
   instruction (would clobber other chained extensions).

### Test strategy (delivered)

Deterministic, no live harness (honoring the #23 lesson): injection-present, suppressed-in-
headless, disabled, feature-detect (no throw), and the name-strip back-compat assertions in
`tests/adapters/pi/`. Smoke checks (`PORT=8889 tests/smoke-core.sh`, the `--external` Pi
build) stay green.
