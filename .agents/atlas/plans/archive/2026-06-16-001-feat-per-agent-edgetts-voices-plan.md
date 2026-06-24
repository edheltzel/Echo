---
title: "feat: Per-agent edgeTTS voice selection"
type: feat
date: 2026-06-16
status: ready
depth: standard
---

# feat: Per-agent edgeTTS voice selection
## Summary
Today every edgeTTS utterance uses a single hardcoded voice (`en-US-AvaNeural`), so all agents sound identical. edge-tts itself exposes 322 neural voices; the system just never routes them. This plan wires per-agent voice selection into the edgeTTS provider — mirroring the `kokoro` and `elevenlabs` mappings that already exist in `core/voices.json` — so each agent speaks in a distinct English-locale neural voice with a persona-matched speaking rate, while any agent without an edgetts mapping cleanly falls back to today's global default.

The change is config-driven and contained: one new optional field on the voice-mapping shape, one branch in the existing 3-tier resolver, a settings pass-through into the provider's `speak()`, and the per-agent voice/rate data — plus a standalone audition script (off the runtime path) for choosing those voices by ear. No HTTP contract change, no adapter change, no touch to the kokoro/elevenlabs paths.

* * *
## Problem Frame
`EdgeTTSProvider.speak()` (`core/server.ts`) resolves its voice as:

```
voice || voicesConfig.providers.edgetts?.defaultVoice || 'en-US-AvaNeural'
```

The `voice` argument is only ever populated for `kokoro` and `elevenlabs` in the resolver (`core/server.ts`, the 3-tier block around the `provider.speak(...)` call). There is **no** `edgetts` **branch**, so `providerVoice` is always `undefined` for edgeTTS and it falls through to the single default. Compounding this, the `VoiceMapping` interface and `core/voices-schema.json` only define `elevenlabs` and `kokoro` sub-objects — agents have no place to declare an edge voice even if the resolver looked for one. Result: agent identity is silently lost on the default provider.

Edge TTS is the `defaultProvider` and both elevenlabs and kokoro are disabled in `core/voices.json`, so this is the path that actually plays in practice — making distinct edge voices the only thing that gives agents distinct sound today.

* * *
## Scope Boundaries
**In scope**

- Add an optional `edgetts` mapping (`voice`, optional `speed`) to the voice-mapping shape, in all three places that define it: the `VoiceMapping` TS interface, `core/voices-schema.json`, and (implicitly) the in-code fallback config which already type-checks against the interface.
  
- Teach the 3-tier resolver to honor `voiceMapping.edgetts` for the `edgetts` provider.
  
- Pass the resolved speaking rate into `EdgeTTSProvider.speak()` without breaking the shared `TTSProvider` interface.
  
- Populate `core/voices.json` with persona-matched English-locale voices + rates for `identity` and all 7 agents.
  
- Add a standalone `scripts/preview-voices.ts` audition utility to sample the available English voices by ear (dev tooling, not on the request path).
  

**Out of scope / non-goals**

- No changes to kokoro, elevenlabs, or say provider behavior.
  
- No change to the `/notify` request/response contract.
  
- No adapter (`adapters/pai`, `adapters/pi`) changes.
  
- No new HTTP endpoints or PAI-named routes.
  
### Deferred to Follow-Up Work
- A general "list available edge voices" introspection endpoint or CLI — not needed for this change.
  
- Non-English locales — the user scoped this to English variants (US, GB, AU, IE).
  
- Caller-supplied `voice` (an arbitrary edge voice id in the request body) reaching edgeTTS — the existing pass-through at the elevenlabs-only branch could later be generalized, but it is outside this persona-mapping change.
  

* * *
## Key Technical Decisions
**KTD1 — Mirror the existing** `kokoro` **mapping shape:** `edgetts: { voice: string, speed?: number }`**.** The kokoro mapping is already `{ voice, speed }` and already flows `speed` through `providerSettings` into `provider.speak(text, voice, settings)`. Reusing that shape means per-agent rate needs **zero new plumbing** — the existing `VoiceSettings.speed` field carries it. Alternative considered: a native edge `rate: "+8%"` string on the mapping. Rejected because the `TTSProvider.speak` interface only accepts `(text, voice?, settings?)`, so a rate string would need a new field on `VoiceSettings` (a wider, interface-touching change) for no functional gain. `speed` is the DRY, interface-preserving choice.

**KTD2 — Derive the edge** `--rate` **string from** `speed` **inside the provider, with** `1.0` **meaning "use the global default".** A small pure helper converts a speed multiplier to edge-tts's percentage rate format (`1.08 → "+8%"`, `0.94 → "-6%"`). A speed of exactly `1.0` (or absent) falls back to `voicesConfig.providers.edgetts?.rate` so existing global behavior is unchanged when no per-agent rate is set. Extracting this as an exported pure function makes the one piece of new branching logic cheaply unit-testable (boundary at 1.0, rounding, sign).

**KTD3 — Honor** `edgetts` **mapping in BOTH resolver tiers (caller-supplied settings AND config-resolved settings).** The resolver's Tier 1 (caller passed explicit `voice_settings`) and Tier 2 (resolve from `voices.json`) both currently set `providerVoice` for kokoro/elevenlabs. The edgetts branch is added to both so an agent's edge voice is used even when a caller overrides settings — consistent with how the other two providers behave.

**KTD4 — Persona-matched voices spanning US, GB, AU, and IE English.** Voices are assigned by each agent's described persona and deliberately spread across the four English locales the user requested, with gender variety. `identity` (Atlas) is pinned to `en-US-AvaNeural` — the existing global default — making Atlas's voice explicit rather than implicit. Rates track persona: brighter/faster for the enthusiastic helper, slower/measured for the engineer and methodical QA.

* * *
## Voice Assignment Table
All voices verified present via `python3 -m edge_tts --list-voices` on this machine.

| Mapping | Persona (from `voices.json`) | Voice | Locale | Gender | `speed` | Derived rate |
|---|---|---|---|---|---|---|
| `identity` (Atlas) | Main assistant voice | `en-US-AvaNeural` | US | F | 1.0 | global default |
| `kai` | UK male — expressive, warm, enthusiastic helper | `en-GB-RyanNeural` | GB | M | 1.08 | +8% |
| `researcher` | Analytical, authoritative, confident | `en-US-AriaNeural` | US | F | 1.0 | +0% |
| `engineer` | Strategic, measured engineering specialist | `en-GB-ThomasNeural` | GB | M | 0.94 | -6% |
| `architect` | Strategic, sophisticated architecture specialist | `en-GB-SoniaNeural` | GB | F | 0.98 | -2% |
| `designer` | Sophisticated critic, design quality | `en-AU-NatashaNeural` | AU | F | 1.0 | +0% |
| `writer` | Articulate, warm, engaging | `en-IE-EmilyNeural` | IE | F | 1.02 | +2% |
| `qa-tester` | Methodical quality / verification | `en-IE-ConnorNeural` | IE | M | 0.96 | -4% |

Locale coverage: US, GB, AU, IE — all four English variants requested, mixed genders.

* * *
## Implementation Units
### U1. Extend the voice-mapping shape with an `edgetts` sub-object
**Goal:** Give agents a typed, schema-valid place to declare an edge voice + rate. **Requirements:** Foundation for KTD1; unblocks U3 and U4. **Dependencies:** none. **Files:**

- `core/server.ts` — add `edgetts?` to the `VoiceMapping` interface.
  
- `core/voices-schema.json` — add an `edgetts` property to `$defs/voiceMapping`.
  

**Approach:** In the `VoiceMapping` interface, add an optional sibling to `elevenlabs`/`kokoro`: `edgetts?: { voice: string; speed?: number }`. In `voices-schema.json` `$defs/voiceMapping.properties`, add an `edgetts` object property mirroring the `kokoro` schema entry (`voice: string`, `speed: number`, `additionalProperties: true`). The field is optional everywhere, so the in-code fallback config and existing `voices.json` remain valid without edits.

**Patterns to follow:** the existing `kokoro` entry in both the interface (`core/server.ts`) and `$defs/voiceMapping` (`core/voices-schema.json`).

**Test scenarios:**

- `voices-schema.json` remains valid JSON and the `edgetts` def mirrors `kokoro`'s shape (covered by U5 schema-shape assertion).
  
- `Test expectation: type/schema only` — no runtime behavior in this unit; behavior is exercised by U3/U5.
  

* * *
### U2. Pass speaking rate into `EdgeTTSProvider.speak()` via settings, with a pure rate helper
**Goal:** Let a per-agent `speed` reach the `edge_tts --rate` flag without breaking the `TTSProvider` interface. **Requirements:** KTD1, KTD2. **Dependencies:** none (independent of U1; combine at U3). **Files:**

- `core/server.ts` — add exported pure helper `edgeRateFromSpeed(speed?: number, fallbackRate?: string): string`; update `EdgeTTSProvider.speak(text, voice?, settings?)` to accept and use `settings`.
  
- `tests/core/edge-rate.test.ts` — unit tests for the helper (created in U5; listed here as the unit under test).
  

**Approach:** `speak` already matches the interface signature `speak(text, voice?, settings?)` — it currently ignores the third arg. Compute `rate = edgeRateFromSpeed(settings?.speed, voicesConfig.providers.edgetts?.rate)`. Helper logic: if `speed` is undefined or exactly `1.0`, return `fallbackRate ?? '+0%'`; otherwise return a signed percentage of `(speed - 1) * 100` rounded to an integer (`+N%` for ≥1, `-N%` for <1; the negative sign comes from the value, only the `+` is prepended). Replace the current inline `const rate = voicesConfig.providers.edgetts?.rate || '+0%'` with the helper call.

**Patterns to follow:** existing `applyPronunciations` as an example of a small pure function in `core/server.ts`; existing `--rate` spawn arg already present in `speak`.

**Test scenarios:** (helper, in U5)

- `edgeRateFromSpeed(1.08)` → `"+8%"`.
  
- `edgeRateFromSpeed(0.94)` → `"-6%"`.
  
- `edgeRateFromSpeed(1.0, "+0%")` → `"+0%"` (boundary: exactly 1.0 uses fallback).
  
- `edgeRateFromSpeed(undefined, "+5%")` → `"+5%"` (absent speed uses fallback).
  
- `edgeRateFromSpeed(undefined)` → `"+0%"` (no fallback → safe default).
  
- `edgeRateFromSpeed(1.005)` → `"+1%"` (rounding) — confirm no fractional `%` reaches edge-tts.
  

* * *
### U3. Add the `edgetts` branch to the 3-tier voice resolver
**Goal:** Populate `providerVoice` and `speed` from `voiceMapping.edgetts` so the agent's voice actually reaches `speak()`. **Requirements:** KTD1, KTD3. **Dependencies:** U1 (type), U2 (speak consumes settings). **Files:**

- `core/server.ts` — the 3-tier resolution block (Tier 1 caller-settings branch and Tier 2 config branch) preceding `provider.speak(text, providerVoice, providerSettings)`.
  

**Approach:**

- **Tier 1** (caller passed `voice_settings`): add `else if (providerName === 'edgetts' && voiceMapping?.edgetts) { providerVoice = voiceMapping.edgetts.voice; }` alongside the existing kokoro/elevenlabs cases (settings stay caller-supplied).
  
- **Tier 2** (resolve from mapping): add `else if (providerName === 'edgetts' && voiceMapping.edgetts) { providerVoice = voiceMapping.edgetts.voice; providerSettings = { ...DEFAULT_VOICE_SETTINGS, speed: voiceMapping.edgetts.speed ?? 1.0 }; }`, mirroring the kokoro branch.
  
- No change needed to Tier 3 (defaults) — absent mapping → `providerVoice` undefined → `speak()` falls back to global default voice and rate. This is the explicit graceful-fallback path.
  

**Patterns to follow:** the adjacent `kokoro` branch in the same block — the edgetts branch is structurally identical (voice + speed).

**Test scenarios:**

- Source-contract (U5): server source contains an `edgetts` branch that reads `voiceMapping.edgetts.voice` in the resolver.
  
- Behavioral (manual smoke, U5): `POST /notify` with `voice_id: "engineer"` logs `🌐 Edge TTS speaking (voice: en-GB-ThomasNeural)`; with `voice_id: "kai"` logs `en-GB-RyanNeural`.
  
- Fallback: `POST /notify` for an agent with no edgetts mapping (or unknown voice_id) still logs the global default voice — no crash, no undefined voice passed to edge-tts.
  

* * *
### U4. Populate `core/voices.json` with per-agent edge voices and rates
**Goal:** Apply the Voice Assignment Table. **Requirements:** KTD4. **Dependencies:** U1 (schema accepts the field); informed by U6 — run the audition utility first to confirm or adjust the per-persona assignments by ear before locking them. **Files:**

- `core/voices.json` — add an `edgetts` block to `identity` and to each of the 7 agents.
  

**Approach:** For each mapping, add `"edgetts": { "voice": "<voice>", "speed": <speed> }` per the Voice Assignment Table, as a sibling of the existing `elevenlabs`/`kokoro` blocks. `identity` gets `{ "voice": "en-US-AvaNeural", "speed": 1.0 }` (explicitly pinning Atlas to the global default per the confirmed scope). `qa-tester` currently has only a `kokoro` block — add `edgetts` alongside it.

**Patterns to follow:** existing `kokoro` blocks in the same file.

**Test scenarios:**

- Config-validity (U5): `voices.json` parses; every agent and `identity` has an `edgetts.voice` that is a non-empty string.
  
- `Covers` the assignment table: each mapping's voice string matches the table (spot-checked in the config-validity test, e.g. `engineer.edgetts.voice === "en-GB-ThomasNeural"`).
  

* * *
### U5. Tests + smoke verification
**Goal:** Lock the new behavior in the repo's existing test style and verify end-to-end audio. **Requirements:** verifies U2, U3, U4. **Dependencies:** U2, U3, U4. **Files:**

- `tests/core/edge-rate.test.ts` — new: unit tests for `edgeRateFromSpeed` (the U2 scenarios).
  
- `tests/core/server-contract-source.test.ts` — extend: assert the resolver contains an `edgetts` branch reading `voiceMapping.edgetts.voice`.
  
- `tests/core/voices-config.test.ts` — new (or fold into an existing config test if one is added): parse `core/voices.json` and `core/voices-schema.json`; assert each agent + `identity` has a valid `edgetts.voice` and that schema `$defs/voiceMapping` declares `edgetts`.
  

**Approach:** Match the existing source-contract + JSON-read test style (`tests/core/server-contract-source.test.ts` reads the source as a string and asserts on it). The only true unit test is the pure rate helper, which is cheap and high-value. Behavioral voice routing is confirmed via the smoke path below since the repo has no provider-mocking harness and exercising real synthesis requires audio.

**Execution note:** write `edge-rate.test.ts` first (test-first) — the helper is pure and the boundary at `speed === 1.0` is the easiest place to get the sign/rounding wrong.

**Test scenarios:**

- All U2 helper scenarios pass.
  
- Source-contract: `core/server.ts` contains the edgetts resolver branch string.
  
- Config-validity: every mapping has a non-empty `edgetts.voice`; schema declares the field.
  

**Verification:**

- `bun test` passes.
  
- `PORT=8889 tests/smoke-core.sh` passes (server boots with the new config).
  
- `bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/atlas-pi-adapter-build` still succeeds (no type break from the interface change).
  
- Manual audio check: restart the service (`launchctl kickstart -k "gui/$UID/com.atlas.voicesystem"`) and `POST /notify` with `voice_id` of `kai`, `engineer`, and `researcher`; confirm three distinct voices in the log line and audibly.
  

* * *
### U6. Voice audition utility — hear the available English edge voices

**Goal:** Let a human play short samples of the available English edge-tts voices (US/GB/AU/IE) on demand, so the persona-to-voice assignments in U4 can be chosen and tuned by ear rather than from voice names alone. **Requirements:** Supports KTD4 — informs and validates the Voice Assignment Table. **Dependencies:** none — independent of U1–U3; intended to run *before* U4 is finalized. **Files:**

- `scripts/preview-voices.ts` — new Bun CLI.
  

**Approach:** A Bun script that enumerates voices via `python3 -m edge_tts --list-voices`, filters to the English locales (`en-US`, `en-GB`, `en-AU`, `en-IE`) by default, and for each voice synthesizes a short sample line to a temp mp3 and plays it sequentially, printing the voice id + gender before each. Reuse the spawn / temp-file / player patterns from `EdgeTTSProvider.speak` in `core/server.ts` (python3 path, `--write-media`, `afplay` on macOS / `mpv` on Linux). Factor the enumeration → locale-filter → command-builder steps as small exported functions so the non-audio paths are unit-testable. Flags:

- `--locale <code,…>` — restrict to specific locales (default: the four English ones).
  
- `--voices <a,b,c>` — audition an explicit set (e.g. the 8 assigned in U4) for direct A/B comparison.
  
- `--text "<phrase>"` — override the sample line (default e.g. `"Hi, I'm {voice}. This is how I sound for Atlas."`).
  
- `--rate <±N%>` — apply a speaking rate so a persona's `speed` choice can be auditioned too.
  
- `--list` / `--dry-run` — print the matched voices (and the synth plan) without playing any audio; the CI-safe, testable path.
  

**Patterns to follow:** `EdgeTTSProvider.speak` (`core/server.ts`) for the `python3 -m edge_tts` spawn, `--write-media`, temp-file creation/cleanup, and platform player selection. Bun-only per `AGENTS.md` — no npm/node workflows.

**Execution note:** Run this unit early (before U4) and re-skim the Voice Assignment Table against what you actually hear; treat the table as a starting point, not a fixed contract.

**Test scenarios:**

- `--list --locale en-GB` prints exactly the en-GB neural voices (Libby, Maisie, Ryan, Sonia, Thomas) and nothing from other locales.
  
- `--dry-run --voices en-GB-RyanNeural` prints the intended synth command (voice + rate + sample text) and spawns no player / writes no audio.
  
- Default `--list` enumerates across all four English locales with a non-zero count for each.
  
- Unknown locale (`--locale xx-XX`) prints a clear "no voices matched" message and exits non-zero — no crash, no stack trace.
  
- `Test expectation:` audio playback is interactive and not asserted in CI; coverage targets the enumeration/filter/command-builder logic via `--list` / `--dry-run`.
  

**Verification:**

- `bun scripts/preview-voices.ts --list` enumerates the English voices.
  
- `bun scripts/preview-voices.ts --voices en-GB-RyanNeural,en-GB-ThomasNeural` plays two audibly distinct samples (manual).
  
- `bun test` covers the `--list` / `--dry-run` paths.
  

* * *
## Risks & Dependencies
- **Voice availability drift.** edge-tts voices come from Microsoft's service; a voice could theoretically be retired. Mitigation: the graceful fallback in U3/U2 means an unknown voice would surface as an edge-tts synthesis failure caught by the existing circuit breaker, then fall through `fallbackOrder` to `say`. Low likelihood for these mainstream voices.
  
- **Rate semantics.** `speed` as a multiplier is an indirection vs. edge's native `%`. Mitigated by the explicit derived-rate column in the assignment table and the helper's unit tests.
  
- **No behavioral unit harness.** Voice routing is asserted via source-contract + manual smoke rather than a mocked provider call. Accepted: matches the repo's current testing posture; the pure helper carries the real logic and is unit-tested.
  

* * *
## Sources & Research
- Codebase: `core/server.ts` (`EdgeTTSProvider`, `getVoiceMapping`, 3-tier resolver, `loadVoicesConfig` fallback), `core/voices.json`, `core/voices-schema.json`, `tests/core/server-contract-source.test.ts` — read directly this session.
  
- `python3 -m edge_tts --list-voices` on this machine — confirmed all 8 assigned voices exist (322 total neural voices; en-US/GB/AU/IE enumerated).
  
- No external research needed: the kokoro/elevenlabs mappings are a complete in-repo template for this exact pattern.
