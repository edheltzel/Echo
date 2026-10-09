---
title: Test Banner Isolation - Plan
type: fix
date: 2026-10-08
topic: test-banner-isolation
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Test Banner Isolation - Plan

## Goal Capsule

- **Objective:** Running Echo's test suite and its smoke and e2e scripts puts no macOS notification banner on the operator's screen.
- **Means:** a configurable banner executable in core, mirroring the existing `ECHO_SAY_BIN` knob, pointed at a no-op by every test surface (KTD1, KTD2).
- **Product authority:** Ed. R-IDs win on behavior, KTDs on mechanism.
- **Stop conditions:** stop if delivering this would change the `/notify` request or response contract, change banner behavior for a real (non-test) daemon, or require host-specific logic in `core/`.
- **Open blockers:** None.
- **Execution:** one PR into `dev`; Ed merges (it touches `core/`).

## Product Contract

### Summary

Make the banner executable a config key (`ECHO_OSASCRIPT_BIN`, default `/usr/bin/osascript`) and point every test surface at `/usr/bin/true`, so test daemons stay off-screen while production banners are unchanged.

### Problem Frame

Every isolated test daemon fires the legacy macOS banner for each `/notify` it accepts. `showBanner` in `core/server.ts` spawns a hardcoded `/usr/bin/osascript`, and nothing in the smoke script, either e2e script, or `tests/core/replay-endpoint.test.ts` (which floods `/notify` against the real in-process server) replaces it. Ed saw a burst of silent banners during a test run and could not tell them from real agent notifications, which is the confusion a voice-notification tool exists to prevent. Most in-process core tests already stub `child_process` for this reason (see the comments in `tests/core/mute-endpoint.test.ts` and `tests/core/mode-endpoint.test.ts`), so the gap is the surfaces that do not.

### Requirements

- R1. No test surface (`bun test`, `tests/smoke-core.sh`, `tests/e2e-adapters.sh`, `tests/e2e-converse.sh`) spawns the real `/usr/bin/osascript` for a banner.
- R2. A daemon with no override still spawns `/usr/bin/osascript` with the same arguments as today; banner text, timing, and the `visual_delivery: "native"` skip are unchanged.
- R3. The override is ordinary Echo configuration: a `config.json` key with an environment fallback, validated and reported like every other key.

### Scope Boundaries

- Not changing the MCP consent dialog's `osascript` call in `adapters/mcp/server.ts`; it is a user-facing prompt, not a notification, and its tests already avoid it.
- Not adding a "banners off" mode for real users. Considered and not built: a boolean toggle duplicates what pointing the key at `/usr/bin/true` already does, and no user has asked for it.
- Not changing the silent `voice_enabled: false` semantics.

## Planning Contract

### Key Technical Decisions

- KTD1. Add `ECHO_OSASCRIPT_BIN`, read once at module load in `core/server.ts` exactly like `MACOS_SAY_BIN` (`resolveEchoEnv("ECHO_SAY_BIN") || '/usr/bin/say'`), and use it in `showBanner`. Registered in the same three places as `ECHO_SAY_BIN`: the canonical key list in `shared/echo-env.ts`, `shared/config-schema.json`, and `docs/configuration.md`. Chosen over a test-only boolean because the repo already has this exact pattern. Chosen over stubbing `child_process` in every test because the shell scripts run a real separate daemon that no stub can reach. Chosen over an unregistered env-only override because the process-env fallback is deprecated and kept for one release (AGENTS.md); after that, only a registered `config.json` key still works.
- KTD2. Each shell script points the key at a recorder written into its scratch dir (a two-line script that appends one line per call to a log and exits 0), sets it in the scratch `config.json` it already generates, and after its notifications asserts the log is non-empty. A recorded line proves the banner went through the override, since `showBanner` spawns nothing else. `bun test` sets the key to `/usr/bin/true` in `tests/preload.ts` as process env: the preload pins `ECHO_CONFIG_FILE` to a missing scratch path, so the env fallback is what core reads.
- KTD3. In-process tests that check the banner compare against the configured executable instead of the literal `"/usr/bin/osascript"`. There are eight: the positive check in `tests/core/capture-guard.test.ts`, the positive check in `tests/core/mute.test.ts`, and six in `tests/core/notify-queue.test.ts` (four positive checks plus the native-skip and replay absence checks). The absence checks must move too, or they pass vacuously while a banner still fires.

### Assumptions

- `/usr/bin/true` exists on every machine that runs these tests. It is POSIX-required and present on macOS and the CI image.
- The burst Ed saw came from these test surfaces; no other code path spawns a notification banner. `grep -rn osascript core shared adapters` finds only `showBanner` and the MCP consent dialog.
- Classified Lightweight despite a new configuration key: its only consumers are this repo's own test scripts, not an external system or another repository.
- The preload rides the deprecated env fallback (KTD2). When that fallback is removed, the preload must write its scratch `config.json` with the key instead; the failure is loud (banner assertions fail), so no guard is added now.

## Implementation Units

### U1. Configurable banner executable in core

**Goal:** `showBanner` spawns the executable named by `ECHO_OSASCRIPT_BIN`, defaulting to `/usr/bin/osascript`.

**Requirements:** R2, R3

**Files:** `core/server.ts`, `shared/echo-env.ts`, `shared/config-schema.json`, `docs/configuration.md`, `tests/core/banner-bin.test.ts` (new)

**Approach:** a module-level constant next to `MACOS_SAY_BIN` (KTD1). Add the key to the canonical list beside `ECHO_SAY_BIN` with a one-line comment, a schema entry with type and description, and a `docs/configuration.md` row in the Server group plus a "not obvious from the name" note.

**Test Scenarios:** each runs in a fresh `bun` subprocess that imports `core/server.ts` itself, like `tests/core/import-purity.test.ts`, because the suite's server singleton has already captured the preload's value.
- With the key unset (deleted from the child env), a banner spawns `/usr/bin/osascript` with `-e` and a `display notification` script.
- With the key set, a banner spawns that executable with the same arguments.
- `config.json` accepts the key without reporting it in `config.ignored_keys`.

**Verification:** the new test passes; `tests/shared` schema and key-list parity tests pass.

### U2. Point every test surface at a no-op

**Goal:** no test run spawns the real banner binary.

**Requirements:** R1

**Files:** `tests/preload.ts`, `tests/smoke-core.sh`, `tests/e2e-adapters.sh`, `tests/e2e-converse.sh`, `tests/core/capture-guard.test.ts`, `tests/core/mute.test.ts`, `tests/core/notify-queue.test.ts`

**Approach:** KTD2 for the preload and the three scripts; KTD3 for the eight assertions.

**Test Scenarios:**
- Smoke and both e2e scripts record at least one banner in their recorder log and fail if it stays empty.
- The eight in-process banner checks pass against the configured executable.
- The positive banner checks still fail if `showBanner` stops spawning.

**Verification:** Verification Contract below.

## Verification Contract

- `bun test` (same 8 known local failures as clean `master`, nothing new).
- `PORT=8889 tests/smoke-core.sh`, `tests/e2e-adapters.sh`, `tests/e2e-converse.sh`.
- Smoke and both e2e scripts' recorder assertions (KTD2) are the proof for those surfaces. For `bun test`, the eight retargeted checks (KTD3) plus the preload pin cover every in-process banner.
- All seven adapter builds listed in AGENTS.md.

## Definition of Done

- R1 to R3 hold and every Verification Contract command passes.
- No real banner appears on screen during a full local run.
- No leftover experimental code; `docs/configuration.md` documents the key.
