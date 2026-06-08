# atlas-voicesystem — Architecture Guide

> Generated 2026-06-06 via multi-agent codebase exploration (8 parallel subsystem readers → synthesis → adversarial completeness critic). All load-bearing claims fact-checked against source with line numbers; critic verdict: complete.

## 1. What it is

atlas-voicesystem is a Bun/TypeScript text-to-speech notification daemon, built as a **host-neutral core plus out-of-process host adapters**. A single long-lived process (`core/server.ts`) listens on `:8888` and exposes `POST /notify`, `POST /notify/personality`, and `GET /health`. Any host — a Claude Code (PAI) session, an `@earendil-works/pi-coding-agent` (Pi) session, or a raw `curl` — observes its own lifecycle events, extracts a short user-facing line (for PAI/Pi, the final `🗣️` line), and POSTs it as JSON. The core sanitizes the text, resolves a voice, and speaks it through a configurable multi-provider TTS fallback chain (Edge TTS → ElevenLabs → Kokoro → macOS `say`) guarded by per-provider circuit breakers, then shows a macOS notification banner. The hard design rule that shapes everything: **`core/` never imports a host API**; all host coupling lives in adapters that talk to the core only over HTTP.

## 2. Architecture at a glance

The repo migrated from a PAI-shaped GNU-stow tree to a **universal core + host adapters** topology. The core is the only thing that synthesizes audio; adapters are pure HTTP clients that translate host events into `POST /notify` calls.

```
  ┌─────────────────────┐   ┌─────────────────────┐   ┌──────────────┐
  │  PAI / Claude Code  │   │  Pi coding agent     │   │ curl / any   │
  │  (host process)     │   │  (host process)      │   │ HTTP client  │
  └──────────┬──────────┘   └──────────┬───────────┘   └──────┬───────┘
   lifecycle events           lifecycle events                 │
  (PreToolUse, SessionStart;  (session_start, message_end,     │
   external Stop hook drives   turn_end, session_shutdown)      │
   completion speech)          │                                │
             │                          │                       │
  ┌──────────▼──────────┐    ┌──────────▼───────────┐          │
  │  adapters/pai/      │    │  adapters/pi/        │          │
  │  - VoiceGate hook   │    │  - index.ts extension│          │
  │  - VoiceGreeting    │    │  - dedupe (spoken/   │          │
  │  - handleVoice()*   │    │    pending, 5s win)  │          │
  │  extract 🗣️ line +  │    │  extract 🗣️ line +   │          │
  │  source/session_id  │    │  source:"pi"         │          │
  └──────────┬──────────┘    └──────────┬───────────┘          │
   * handleVoice has no in-repo caller (see §4 critical gap)    │
             │   POST JSON {message, voice_id?, source, session_id?}
             └──────────────┬───────────┴───────────────────────┘
                            │  HTTP  →  http://localhost:8888/notify
                ┌───────────▼──────────────────────────────────┐
                │   core/server.ts  (Bun serve, :8888)          │
                │   1. rate-limit (10/60s per client IP)        │
                │   2. validateInput + sanitizeForSpeech (≤500) │
                │   3. extractEmotionalMarker / stripMarkers    │
                │   4. getVoiceMapping (voices.json)            │
                │   5. 3-tier voice-settings resolution         │
                │   6. applyPronunciations (pronunciations.json)│
                │   7. speakWithFallback ─────────────┐         │
                └─────────────────────────────────────┼─────────┘
                                                       │
        provider order = [defaultProvider, ...fallbackOrder]
        each: skip if !enabled || !healthy (circuit breaker)
                                                       │
   ┌──────────────┬──────────────┬───────────────┬────▼─────────┐
   │  edgetts     │  elevenlabs  │   kokoro      │   say        │
   │ (python      │ (api.eleven  │ (127.0.0.1:   │ (/usr/bin/   │
   │  edge_tts)   │  labs.io)    │  8880/v1)     │  say)        │
   └──────┬───────┴──────┬───────┴───────┬───────┴──────┬───────┘
          │ afplay/mpv   │ afplay        │ afplay       │ (native)
          └──────────────┴───────┬───────┴──────────────┘
                                 ▼
                        AUDIO  +  osascript banner
```

First provider to return `true` wins. Notify failures are non-fatal to the host session by contract.

## 3. The universal core

`core/server.ts` (1284 lines, **zero exports** — it runs `serve()` + a top-level-await startup banner on import) is the entire daemon: env/config loading, the pronunciation engine, emotional presets, four TTS provider classes, circuit breakers, voice resolution, rate limiting, and the Bun `serve()` HTTP handler.

**Startup.** Env files load from `VOICESYSTEM_ENV_PATHS` (colon-separated), then `~/.config/atlas-voicesystem/.env`, `~/.config/voicesystem/.env`, `~/.env`. The loader sets a key only when `key && value && !key.startsWith('#') && !process.env[key]` — so it is **first-found-wins per key, never overrides an already-set `process.env` value, and silently skips any line whose value is empty** (an empty-valued key is dropped entirely, not just deferred). `voices.json` is parsed once (deep-merged over a hardcoded `defaultConfig`); `pronunciations.json` is compiled into word-boundary regexes once. There is **no hot reload** — editing either config file requires a restart. Then `serve()` binds `PORT` (default `8888`).

**HTTP contract:**

| Endpoint | Behavior |
|---|---|
| `POST /notify` | (`server.ts:1134`) Primary endpoint. Defaults: `title`=`VOICESYSTEM_DEFAULT_TITLE` (`"Voice Notification"`), `message`=`"Task completed"`, `voice_enabled`=true unless explicitly `false`, `voiceId`=`voice_id`\|\|`voice_name`\|\|null. Throws `Invalid voice_id` (→400) if `voice_id` is non-string. Returns `200 {status:'success', message:'Notification sent', request_id}`. Errors whose message contains `'Invalid'` → 400, else 500. |
| `POST /notify/personality` | (`server.ts:1176`) Compatibility shim. Ignores all voice fields; always calls `sendNotification(DEFAULT_NOTIFICATION_TITLE, message, true, null)`. For callers that only have a `message`. |
| `GET /health` | (`server.ts:1207`) Runs `getProviderStatus()` (live `isHealthy()` per provider). Returns provider status, `fallbackOrder`, `macos_fallback_voice`, `pronunciation_rules` count, `emotional_presets` count (computed dynamically as `Object.keys(EMOTIONAL_PRESETS).length`), and a `circuit_breakers` block. |
| `OPTIONS *` | 204 with CORS headers; `Access-Control-Allow-Origin` is hardcoded to `http://localhost`. |
| unknown `POST` | Explicit **JSON 404** `{status:'error', message:'Unsupported endpoint: <path>', supported_endpoints:[...]}`. No PAI-named route exists. |
| unknown non-POST (incl. `GET /`) | **plain-text 404** usage string. |

**Request pipeline:** derive `clientIp` from `x-forwarded-for` (else literal `'localhost'`) → `checkRateLimit(ip)` → route. `sendNotification()` (`server.ts:1018`) runs `validateInput()` (string, ≤500 chars, non-empty after sanitize), `sanitizeForSpeech()` (strips `<script`, `../`, shell metachars `[;&|><\`$\\]`, markdown emphasis/code/headers; trims to 500), `extractEmotionalMarker()` (leading `[<emoji> <name>]`), `stripMarkers()`, then `speakWithFallback()` if voice-enabled, then an `osascript display notification` banner.

**Provider fallback chain.** `speakWithFallback()` (`server.ts:914`) builds `providerOrder = [defaultProvider, ...fallbackOrder.filter(p => p !== defaultProvider)]`. Config ships `defaultProvider='edgetts'`, `fallbackOrder=['edgetts','elevenlabs','kokoro','say']`. The four providers implement a `TTSProvider` interface (`name`, `isEnabled`, `isHealthy`, `speak`):
- **edgetts** — spawns `python3 -m edge_tts` (hardcoded `/opt/homebrew/bin/python3`, Apple-Silicon path) to write mp3, plays via `afplay` (darwin) / `mpv` (linux). `isHealthy()` spawns a python import check.
- **elevenlabs** — POST `api.elevenlabs.io/v1/text-to-speech` (model `eleven_turbo_v2_5`), plays mp3 via `afplay`.
- **kokoro** — POST `endpoint/audio/speech` (model `kokoro`, local `127.0.0.1:8880`), plays via `afplay`.
- **say** — `/usr/bin/say`.

Each provider re-applies `applyPronunciations(text)`. **On a default install only `edgetts` and `say` are enabled** (`voices.json` ships `kokoro.enabled=false` and `elevenlabs.enabled=false`).

**Circuit breaker.** Per-provider state machine: CLOSED → OPEN after `CIRCUIT_BREAKER_THRESHOLD=1` failure → HALF-OPEN after `CIRCUIT_BREAKER_RESET_MS=60000` (probe allowed) → CLOSED on success. **Threshold is 1** — a single transient failure opens a provider for a full 60s. Breakers exist only for edgetts/elevenlabs/kokoro; `recordProvider*` no-ops for `say`.

**Rate limiting.** `RATE_LIMIT=10` requests per `RATE_WINDOW=60000`ms **per client IP**, 429 on breach. With no proxy, every direct local caller shares the single `'localhost'` bucket.

**Pronunciation + emotional presets.** Pronunciations are `{term, phonetic, note?}` compiled to `/\bterm\b/g`; default install has `Kai→Kye` and `ISC→I S C`. Emotion: a leading `[<emoji> <name>]` marker maps (only when `EMOJI_TO_EMOTION[emoji]===name`) to one of **13** `EMOTIONAL_PRESETS` (`excited, celebration, insight, creative, success, progress, investigating, debugging, learning, pondering, focused, caution, urgent`, each paired with one of 13 `EMOJI_TO_EMOTION` entries); the overlay only overrides `stability` + `similarity_boost`, applied last.

**Voice resolution (3 tiers).** `getVoiceMapping(voiceId)`: null → identity; else exact agent-name match, else match by `elevenlabs.voice_id` across agents, else identity-by-voice_id, else null. Settings: **Tier 1** caller `voice_settings` pass-through; **Tier 2** mapping-derived per-provider settings (kokoro: voice+speed; elevenlabs: voice_id+stability/similarity/style/speaker_boost); **Tier 3** `DEFAULT_VOICE_SETTINGS`. If no mapping, provider==elevenlabs, and a raw `voiceId` was given (and no caller settings), that id is used directly. Note: `voice_settings.speed` affects **Kokoro only** — ElevenLabs ignores it.

## 4. The adapters

Both adapters are **fully out-of-process**, import nothing from `core/`, and speak only the HTTP `/notify` contract. They are independent: each carries its own config and its own copy of the wire types (see §7 drift).

### PAI adapter (`adapters/pai/`)

Observes Claude Code lifecycle events via three hooks plus a registrar:

- **`VoiceGate.hook.ts`** (PreToolUse, matcher=`Bash`) — reads stdin `HookInput`, fast-paths any command not targeting `localhost:8888`/`127.0.0.1:8888`, and **blocks** (`{decision:'block', reason}`) the voice curl when `agent_id` is present (subagent context), so only the main session emits voice. **Fails open** (`{continue:true}`) on any parse error.
- **`VoiceGreeting.hook.ts`** (SessionStart, matcher=`startup`, async) — five suppression layers (`PAI_SUPPRESS_VOICE`, `CLAUDE_CODE_AGENT_TASK_ID`, `CLAUDE_AGENT_TYPE=loop-worker`, project-dir check, then `source==='startup'`), then either announces a named subagent in that agent's voice (frontmatter from `~/.claude/agents/<type>.md`) or speaks Atlas's startup catchphrase from `settings.json`. **Fails safe-silent** (no greet on unknown source). Routes to `/notify/personality` if `daidentity.personality.baseVoice` is set, else `/notify`.
- **`handleVoice(parsed, sessionId)`** (`hooks/handlers/VoiceNotification.ts:177`) — the Stop-phase completion-speech handler. Validates the extracted `🗣️` line via `isValidVoiceCompletion` (rejects filler/<5-char/single-word), suppresses lines matching the startup catchphrase (substring match), builds an ElevenLabs payload from `getIdentity()`, POSTs to `:8888/notify` with a **12s (12000ms) `AbortController` timeout** (`VoiceNotification.ts:128`), and appends a `VoiceEvent` to `~/.claude/MEMORY/VOICE/voice-events.jsonl`.
- **`restore-hooks.ts`** — idempotent registrar. Inserts `VoiceGate` into the existing PreToolUse matcher=`Bash` entry and adds a SessionStart matcher=`startup` entry with `VoiceGreeting` in `~/.claude/settings.json`. Backs up (timestamped `.bak`), atomic temp+rename write, `chmod 0600`. `--check` is a non-mutating preflight. Hard FATAL exit 2 if no PreToolUse Bash matcher exists. Dedupes against current/legacy/historical command paths.

Supporting `lib/`: `identity.ts` (cached settings.json reader → DA name, `mainDAVoiceID`, prosody), `paths.ts` (`paiPath`/`getPaiDir`/`expandPath`), `time.ts` (timezone-aware timestamps), `hook-logger.ts` (JSONL debug log), `output-validators.ts` (voice/tab-title content gates). All logging swallows errors so a hook never crashes the host.

**Critical gap:** `restore-hooks.ts` registers only `VoiceGate` + `VoiceGreeting`, and `handleVoice` has **no in-repo caller** (its only reference is its own definition at `VoiceNotification.ts:177`). The Stop hook that drives completion speech lives **outside this repo**. Net effect — confirmed regardless of the exact external path: a clean atlas-voicesystem PAI install installs gate + greeting but does **not** wire up the headline `🗣️` completion-speech feature.

### Pi adapter (`adapters/pi/`)

A Pi extension (`package.json` declares `pi.extensions=["./index.ts"]`, peerDep `@earendil-works/pi-coding-agent >=0.78.0`). Default export `atlasVoicePiAdapter(pi)` loads config once, allocates dedupe state, and registers handlers for `session_start`, `message_end`, `turn_end`, `session_shutdown` plus a `/voice-status` command.

- **Observes:** `session_start` → greet (unless reason `'reload'`). `message_end`/`turn_end` → `speakAssistantCompletion`. `session_shutdown` → clear dedupe state.
- **Extracts:** `extractVoiceLineFromMessage` → `getAssistantText` (role must be `assistant`) → last `🗣️` line → `isValidVoiceLine` (5–500 chars, rejects generic acks like `done/ok/ready/thanks`).
- **Dedupes:** two-tier. A synchronous `pending: Set` guards in-flight duplicates; a time-bounded `spoken: Map` (5s `DEDUPE_WINDOW_MS`) guards just-completed ones. Key = `stableMessageKey(sessionId, subject, lineText)` = `'<sessionId>:<djb2hash>'`, where the fingerprint = `${messageIdentity(subject)}\nline:${lineText}` folds in the line text so the **same message via both `message_end` and `turn_end` collapses to one speak**. `stableHash` is djb2 (seed 5381, `<<5 + hash ^ charCode`, `>>>0`, base36). A failed notify does **not** record into `spoken`, so a later identical event can retry.
- **Notify:** `sendPiNotify` uses `DEFAULT_PI_NOTIFY_TIMEOUT_MS=10_000` (10s `AbortController` timeout, `notify-client.ts:3`).
- **Config (env-only, independent):** `loadPiVoiceConfig` reads `ATLAS_VOICE_NOTIFY_URL`/`VOICESYSTEM_NOTIFY_URL` (default `http://localhost:8888/notify`), `ATLAS_VOICE_TITLE` (`"Pi Notification"`), `ATLAS_VOICE_CATCHPHRASE` (`"Pi session ready."`), `ATLAS_VOICE_ID`/`VOICESYSTEM_VOICE_ID`. `shouldSuppressVoice` returns true for `ATLAS_VOICE_SUPPRESS`, `PI_SUBAGENT_CHILD=1`, `PI_SUBAGENT_FANOUT_CHILD=1`, or `PI_SUBAGENT_PARENT_RUN_ID`. Every payload hard-codes `source:'pi'`.

**Independence.** The two adapters deliberately share no code. PAI uses stdin `agent_id` to suppress subagents; Pi uses `PI_SUBAGENT_*` env vars. PAI reads `~/.claude/settings.json` for identity; Pi reads only env. The only thing they agree on is the wire shape of `POST /notify`.

## 5. Lifecycle & install

**Service identity (fixed):** LaunchAgent label `com.atlas.voicesystem`; plist `~/Library/LaunchAgents/com.atlas.voicesystem.plist`; log `~/Library/Logs/atlas-voicesystem.log`.

**`scripts/install.sh [--adapter none|pai|pi]`** (default `none`) runs five phases:
1. `preflight()` — require `bun`; for `pai` dry-run `restore-hooks.ts --check`; for `pi` require the `pi` CLI.
2. `write_plist()` — atomic temp(`$$`)+`mv`. ProgramArguments = `$(command -v bun) run <REPO_ROOT>/core/server.ts`. `RunAtLoad=true`, `KeepAlive` only on non-successful exit. Sets `HOME` + a fixed `PATH`. **Does not set `PORT`**, so the daemon uses its default 8888.
3. `migrate_legacy_service()` — unload `com.pai.voice-server`, quarantine its plist to `.migrated-<timestamp>` (rename, never delete). Hard-fail if it's still loaded or reappears.
4. `reload_core_service()` — unload/load `com.atlas.voicesystem`, then `curl -fsS http://localhost:8888/health`.
5. `install_adapter()` — `pai`: `bun run adapters/pai/restore-hooks.ts`; `pi`: `pi install <REPO_ROOT>/adapters/pi`; `none`: nothing.

Lifecycle scripts (`start/stop/restart/status/uninstall.sh`) each re-derive `SERVICE_NAME`/`PLIST_PATH`/`LOG_PATH`, use `launchctl list | grep` for load detection, and probe `:8888/health`. `stop`/`uninstall` only **warn** (never kill) if `:8888` is still in use. `uninstall.sh` removes the plist but **preserves the log** and does **not** revert PAI settings.json hook registrations. All scripts use `set -euo pipefail`; none write to `/tmp`.

## 6. The compatibility tree

`claudecode/.claude/PAI/USER/Voice/` is a **strangler-fig compatibility shim** that keeps pre-migration PAI installs working:
- `server.ts` (26 lines) sets legacy env defaults via `??=` (`VOICES_PATH`/`PRONUNCIATIONS_PATH` → its sibling files, `VOICESYSTEM_DEFAULT_TITLE="PAI Notification"`, legacy `VOICESYSTEM_ENV_PATHS`) then dynamically imports `core/server.ts`. The **active** installer's plist runs `core/server.ts` directly, so this file matters only for manually-kept legacy plists.
- Hook entrypoints (`VoiceGate.hook.ts`, `VoiceGreeting.hook.ts`) are 4-line dynamic-import wrappers; `handlers/VoiceNotification.ts` is a 2-line re-export.
- The six lifecycle `.sh` scripts `exec` the root `scripts/` equivalents; `install.sh` defaults to `--adapter pai`.

`restore-hooks.ts` dedupes against these legacy paths so re-running install never double-registers.

**Drift risk (the main hazard of this tree):**
- `voices.json` here (244 lines) is a **standalone copy, not a symlink/re-export** of `core/voices.json` (140 lines). Rosters already diverge — the mirror carries a larger PAI-branded roster (e.g. `perplexity-researcher`, `claude-researcher`, `gemini-researcher`, `artist`, `pentester`, `intern`, `codex-researcher`, `grok-researcher`, `algorithm`), with "Atlas" branding and tab indentation; core has a neutral 7-agent roster. The compat `server.ts` points `VOICES_PATH` here, so legacy installs get a different voice set. **No automation keeps them in sync.**
- `pronunciations.json` mirror (9 lines) adds `PAI→pie` and an **unresolved template token `{PRINCIPAL.LAST_NAME}` (mapped to `{PHONETIC}`)** that would be applied literally as a pronunciation rule.
- The `lib/` files (`paths`, `identity`, `hook-logger`, `output-validators`, `time`) are **byte-identical duplicates, not re-exports** — currently in sync, silently stale on any future adapter edit.
- The menubar plugin (`menubar/pai-voice.5s.sh`) is stale: references a non-existent `PAI_DIR/VoiceServer` dir and the old `pai-voice-server.log`. No neutral equivalent, no test coverage.

Repo meta: `.githooks/pre-push` blocks direct pushes to `master` (active via `core.hooksPath=.githooks`; also duplicated byte-identically in `.git/hooks/pre-push`). `.gitignore` ignores logs, `/tmp/`, and audio artifacts.

## 7. Data contracts

| File | Shape | Consumed by |
|---|---|---|
| `core/types.ts` | `NotifyPayload {message (required), title?, voice_enabled?, voice_id?, voice_name?, voice_settings?, session_id?, source?}`; `VoiceSettings {stability?, similarity_boost?, style?, speed?, use_speaker_boost?}`; `NotifyResult {ok, status, body, requestId?}`; `HostAdapterInfo` (**exported but unused anywhere**) | Imported only by `core/notify-client.ts`. The server re-declares matching interfaces locally instead of importing this. |
| `core/notify-client.ts` | `DEFAULT_NOTIFY_ENDPOINT="http://localhost:8888/notify"`, `DEFAULT_NOTIFY_TIMEOUT_MS=10000`, `normalizeNotifyPayload` (drops undefined optionals), `sendNotifyPayload` (POST JSON + AbortSignal timeout, parses `request_id`) | **Imported only by tests.** No adapter uses it. |
| `core/voices.json` (140 lines) | `{providers:{edgetts,kokoro,elevenlabs,say}, defaultProvider:"edgetts", fallbackOrder:["edgetts","elevenlabs","kokoro","say"], default_rate, default_volume, identity, agents}` | `core/server.ts` `loadVoicesConfig()` (path via `VOICES_PATH`). |
| `core/voices-schema.json` | JSON Schema (draft 2020-12), requires `providers/defaultProvider/fallbackOrder/identity/agents`; `additionalProperties:true` everywhere; `providerConfig` requires only `enabled` | **`$schema` pointer only — never validated at runtime.** No ajv/validator exists in code or tests. |
| `core/pronunciations.json` | `{replacements:[{term, phonetic, note?}]}` | `core/server.ts` `loadPronunciations()` (path via `PRONUNCIATIONS_PATH`). |

**The headline contract problem: nobody shares the shared client.** Neither adapter imports `core/notify-client.ts` or `core/types.ts`. `adapters/pi/notify-client.ts` re-declares `PiNotifyPayload`/`PiNotifyResult` and its own send logic; `adapters/pai/.../VoiceNotification.ts` re-declares `ElevenLabsNotificationPayload` and fetches `:8888` directly; `core/server.ts` re-declares `VoiceSettings`/`VoicesConfig` locally. `sendNotifyPayload` and `HostAdapterInfo` have **zero non-test consumers**. Any change to the `/notify` shape must be hand-propagated to 4+ places.

`ELEVENLABS_API_KEY` is interpolated server-side into the `${ELEVENLABS_API_KEY}` placeholder in `voices.json`. `default_volume` must be 0..1 (else falls back to 1.0). The top-level `voice_name` alias is accepted by the server as a synonym for `voice_id`, though the schema uses `voice_name` only as a human label inside elevenlabs blocks (possibly vestigial).

## 8. Test coverage

`bun test` runs **32 tests across 10 `.ts` files** (~3.6s, all passing). It does **not** run the two `.sh` smoke scripts. Two strategies: static source-string assertions (cheap, shape-only) and behavioral tests (import-and-call, or `Bun.spawn` a real subprocess against fake `bun`/`curl`/`launchctl` shims on PATH).

**Well protected:**
- **Pi adapter** — the strongest coverage. `pi-adapter.test.ts` drives the real handlers with mocked `globalThis.fetch` + `Date.now`: greeting payload shape, single-speak dedupe across `message_end`+`turn_end`, retry-after-503 (failure doesn't poison dedupe), 5s window expiry. Plus unit tests for config, notify-payload build, and voice-line extraction.
- **Install/migration** — `install-script.test.ts` spawns the real `install.sh` in a temp HOME, asserting legacy quarantine, plist write, and `unload`-precedes-`load` order.
- **Hook registration** — `restore-hooks-paths.test.ts` spawns `restore-hooks.ts` with a temp settings.json: `--check` non-mutating, idempotency, missing-Bash-matcher exit 2.
- **Architectural invariants** — `no-host-strings.test.ts` (no `PAI|Claude|\.claude|OpenCode|\bPi\b` in any `core/` file), `server-contract-source.test.ts` (neutral title, JSON 404, no-`/tmp` audio paths — **source-string level only**), `docs-links.test.ts`.

**Biggest gaps (in severity order):**
1. **`core/server.ts` (the entire TTS engine) is almost entirely untested at runtime.** It exports nothing, so it can only be smoke-tested by spawning the process — which only `smoke-core.sh` does, hitting `/health` and a silent `/notify`. `server-contract-source.test.ts` asserts source substrings and would pass even if the route logic were broken.
2. **Zero tests for the core pipeline:** `speakWithFallback`, `sendNotification`, `getVoiceMapping`, `validateInput`, `sanitizeForSpeech`, `applyPronunciations`, `extractEmotionalMarker`, circuit breakers, and the entire fallback chain.
3. **PAI hooks (`VoiceGate`, `VoiceGreeting`) have no behavioral tests** in `bun test` — only string-referenced; verified only by the manual `bun run ... | hook` commands in AGENTS.md.
4. **`sendNotifyPayload` (timeout/abort/`request_id` parsing) is untested** — only `normalizeNotifyPayload` is.
5. The IP rate limiter and 429 path, `/notify/personality` logic, the happy-path response shape, 400-vs-500 branching, CORS/OPTIONS, and `voice_id` type validation are all untested.
6. `smoke-core.sh`/`smoke-pi.sh` are not picked up by `bun test`. No root `package.json` or CI config was found to confirm orchestration (**unverified**).

## 9. Invariants / must-not-do

- **Never import a host API into `core/`** — no PAI, Pi, Claude Code, or OpenCode. Enforced by `no-host-strings.test.ts`.
- **No new PAI-named endpoints.** Core exposes only `POST /notify`, `POST /notify/personality`, `GET /health`. Unsupported POSTs return JSON 404 with `supported_endpoints`.
- **Do not change the `/notify` request/response contract** without an explicit compatibility plan.
- **All voice traffic is `:8888`.** No new `localhost:31337` references (the legacy Pulse port; none found in `core/`/`scripts/`/`adapters/`).
- **Never write process state to `/tmp`** — use user-owned cache/log/config paths. Audio temp files use `AUDIO_CACHE_DIR` + `mkdtempSync` (mode `0o700`).
- **Do not broad-kill whatever owns port 8888** — it may be another service.
- **Bun + TypeScript only.** No npm/npx/node, no CommonJS `require`. Python only as the out-of-process `edge_tts` dependency.
- **Do not commit secrets or `.env` files.**
- **Do not push directly to `master`** — work on `dev`, PR `dev`→`master` (enforced by `.githooks/pre-push`).
- **Adapters are out-of-process `/notify` clients** that suppress child/subagent contexts and treat notify failures as non-fatal.
- The compat `server.ts` must only set env defaults (via `??=`) and import `core/server.ts` — no host logic. Compat hooks must stay pure wrappers/re-exports.
- Config loads once at startup — editing `voices.json`/`pronunciations.json` requires a restart.

## 10. Risks & open questions (ranked, deduped)

**HIGH**
1. **`core/server.ts` runtime is effectively untested.** The 1284-line TTS engine has no unit coverage (zero exports) and only a `/health` + silent-`/notify` smoke check. Single biggest lever: extract its pure functions for unit testing.
2. **Wire-contract duplication / drift.** Neither adapter consumes the shared `core/notify-client.ts`/`core/types.ts`; the payload shape is hand-redeclared in 4+ places. Any `/notify` change must be propagated by hand.
3. **PAI completion-speech is not installed by this repo.** `restore-hooks.ts` registers only `VoiceGate` + `VoiceGreeting`, and `handleVoice` has no in-repo caller. A clean PAI install gets gate+greeting but **not** the headline `🗣️` completion feature. *Open question: is the Stop orchestrator meant to ship here, or assumed pre-existing PAI infra?*

**MEDIUM**
4. **`voices.json` catalog divergence** between `core/voices.json` (140 lines, 7 neutral agents) and the PAI compat copy (244 lines, PAI-branded roster). The running service uses whichever `VOICES_PATH` points at; nothing keeps them in sync.
5. **Circuit-breaker threshold of 1** makes the primary provider brittle: one network blip or cold `edge_tts` import opens it for a full 60s.
6. **Rate limiter is both too coarse and trivially bypassable** — keyed on `x-forwarded-for` falling back to literal `'localhost'`, so all local callers share one 10/60s bucket, while a spoofed header dodges it entirely.
7. **`PORT` mismatch hazard.** Scripts hardcode `:8888` probes but `core/server.ts` reads `PORT` from env and the plist doesn't pass it through. If `PORT` is exported at install time, the daemon binds elsewhere while scripts falsely report failure.
8. **`uninstall.sh` leaves PAI hook registrations behind.** No inverse of `restore-hooks.ts`; after uninstall + repo deletion, Claude Code retains hook entries pointing at dead paths.
9. **Pi dedupe correctness depends on unverified host behavior** — if real Pi delivers different `message_id` for `message_end` vs `turn_end`, the same reply speaks twice. Tests pass only because the mock reuses one id.
10. **PAI compat config drift** — `pronunciations.json` mirror carries an unresolved `{PRINCIPAL.LAST_NAME}` token applied literally; mirror `lib/` files are byte-identical copies that go stale silently.
11. **Stale menubar plugin** — references a non-existent `VoiceServer` dir and old log; no neutral equivalent, no tests.
12. **Uncommitted/untracked docs** — `docs/agents/*` and the AGENTS.md "Agent skills" edit reference files (`CONTEXT.md`, `docs/adr/`) that don't exist yet.

**LOW (notable)**
- `VoiceGate` blocks only on literal substrings `localhost:8888`/`127.0.0.1:8888` — a subagent reaching the core by hostname/`::1`/alias bypasses it.
- `getProviderStatus()` type omits the `apiKeyConfigured` field it returns; `/health` `circuit_breakers` omits `edgetts` (the default provider) — lists only `elevenlabs`, `kokoro`, plus `threshold`/`reset_after_ms`.
- `sanitizeForSpeech` silently mangles legitimate `$ & > <` and markdown in spoken + banner text.
- `GET /` returns 404 (confuses liveness probes expecting 200 on root).
- `edge_tts` `isHealthy()` spawns a python process on every `/health` and every speak attempt (latency).
- `PYTHON3_PATH` hardcoded to `/opt/homebrew/bin/python3` (Apple-Silicon only).
- `voices-schema.json` is decorative (`additionalProperties:true`, only `enabled` required) — false confidence about config correctness.
- `install.sh` uses deprecated `launchctl load/unload` rather than `bootstrap/bootout`.
- `restore-hooks.ts` hardcodes `HISTORICAL_REPO_ROOT=~/Developer/atlas-voicesystem` (personal path in shipped tooling).

**Could not verify this pass:** CI orchestration / root test config; whether legacy `com.pai.voice-server` plists still exist on real machines; the exact accepted PAI `PreToolUse` block schema; the real Pi assistant-message schema and whether `message_end`/`turn_end` share a message id; the production Pi load path; the exact external Stop-hook filename for PAI completion speech.

**Key paths for orientation:** `core/server.ts`, `core/voices.json`, `adapters/pai/`, `adapters/pi/`, `scripts/install.sh`, `AGENTS.md`.
