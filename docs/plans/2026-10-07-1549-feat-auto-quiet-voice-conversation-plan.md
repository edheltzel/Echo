---
title: Auto-Quiet During Desktop Voice Conversations - Plan
type: feat
date: 2026-10-07
topic: auto-quiet-voice-conversation
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
---

# Auto-Quiet During Desktop Voice Conversations - Plan

## Goal Capsule

- **Objective:** Echo never talks over a voice conversation the operator is having in the ChatGPT or Claude desktop app, and the operator still hears when an agent needs them or finishes.
- **Product authority:** Ed. This plan covers automatic switching during desktop voice conversations only. The sound set and the sounds-only mode it switches into belong to [the notification sounds plan](2026-10-07-1549-feat-notification-sounds-plan.md).
- **Open blockers:** Depends on the notification sounds plan shipping its sounds-only behavior first. Planning is paused on the two `Resolve Before Planning` questions: whether a background process can see which app holds the microphone, and how desktop-app events reach Echo today.

---

## Product Contract

### Summary

While an app on a configurable list (ChatGPT and Claude desktop by default) is in a voice conversation, Echo automatically behaves as sounds-only, then returns to the operator's chosen mode when the conversation ends. `echo_ask` refuses to speak during that time and tells the agent why.

### Problem Frame

The operator uses voice mode in the ChatGPT and Claude desktop apps. Echo keeps speaking during those conversations for two reasons: terminal agent sessions announce requests and completions, and the desktop app itself triggers Echo speech. The result is two voices at once, with Echo replying to things it should not. Muting by hand works but is easy to forget both ways: Echo talks over the conversation, or stays muted afterward.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan covers automatic quieting during desktop voice conversations. The breakdown below is the current understanding, not a committed roadmap.

- Notification sounds and sounds-only mode ([plan](2026-10-07-1549-feat-notification-sounds-plan.md)).
  - This plan depends on it: R3 reuses its sounds-only behavior and mute rules.
- Desktop-app notification sounds: dropped. ChatGPT and Claude desktop already play their own notification sounds, so Echo adds nothing for those sessions beyond this plan.

### Key Decisions

- **Switch to sounds-only, not silence or a hold queue.** The operator keeps request and done cues without speech colliding. Governs R3. (session-settled: user-directed - chosen over full silence or hold-and-speak-later: silence misses blocked agents, held lines go stale.)
- **Trigger from a configurable app list.** Predictable, and extendable to Zoom or FaceTime without a code change. Governs R1, R2. (session-settled: user-approved - chosen over any app using the mic, or a fixed two-app list.)
- **On by default, can be disabled.** Works without setup for the operator's two apps. Governs R5. (session-settled: user-approved - chosen over opt-in or always-on.)
- **`echo_ask` fails fast during a desktop voice conversation.** This overrides, for this window only, the notification sounds plan's rule that `echo_ask` is always spoken. Governs R6. (session-settled: user-approved - chosen over waiting for the conversation to end or speaking anyway.)
- **No new Echo behavior for desktop-app sessions outside voice mode.** Those apps' own notification sounds are enough. (session-settled: user-directed - chosen over always-sounds for desktop sessions or new desktop integration.)

### Requirements

**Detection**

- R1. Echo detects when an app on its conversation-app list is in an active voice conversation, without manual action from the operator.
- R2. The list ships with the ChatGPT and Claude desktop apps, and the operator can add or remove apps in config.

**Behavior while active**

- R3. While a listed app's conversation is active, Echo behaves as in sounds-only mode, whatever mode the operator configured, and every mute rule from the notification sounds plan still applies.
- R4. When the conversation ends, Echo returns to the configured mode without changing the stored setting.
- R5. Auto-quiet is on by default, and one config setting turns it off.
- R6. During an active conversation, an `echo_ask` call speaks nothing, opens no microphone, and returns a result telling the agent the operator is in a voice conversation; it plays the request sound only when R3's mute rules allow sounds.

**Visibility**

- R7. Echo's status surfaces (`cli/echo status` and the in-session mute status) show when auto-quiet is active and which app triggered it.

### Acceptance Examples

- AE1. **Covers R1, R3.** **Given** speech mode and nothing muted, **when** the operator starts a voice conversation in the ChatGPT desktop app and a Claude Code session then finishes, **then** the done sound plays and nothing is spoken.
- AE2. **Covers R4.** **Given** auto-quiet is active, **when** the desktop voice conversation ends and an agent then requests approval, **then** Echo speaks its approval line as usual.
- AE3. **Covers R3.** **Given** `mute all` is active, **when** a desktop voice conversation starts and an agent finishes, **then** nothing is audible.
- AE4. **Covers R5.** **Given** auto-quiet is disabled in config, **when** a desktop voice conversation is active, **then** Echo speaks as its configured mode says.
- AE5. **Covers R6.** **Given** a desktop voice conversation is active and nothing is muted, **when** an agent calls `echo_ask`, **then** the request sound plays and the tool returns a voice-conversation-active result without speaking or recording.
- AE6. **Covers R2.** **Given** the operator added Zoom to the list, **when** a Zoom call is active, **then** Echo is in sounds-only behavior until the call ends.

### Scope Boundaries

- Apps not on the list do not trigger auto-quiet, even when they use the microphone.
- No queueing or later replay of lines that would have been spoken during the conversation; the existing `cli/echo replay` is unchanged.
- No sounds or speech added for desktop-app sessions outside voice mode.
- Terminal harness voice modes are not targets of this plan. omp (`live-delegation`) and Codex (`realtime_active`) already suppress their own live sessions per session in the adapter, without touching daemon mute.

### Dependencies / Assumptions

- Assumes "the listed app has the microphone open" is a reliable signal for "in a voice conversation". If a listed app holds the mic for other reasons (dictation into a text field), auto-quiet triggers then too, which is acceptable.
- The daemon is a background LaunchAgent. Root `AGENTS.md` forbids an always-on process from opening the microphone; detection must only observe other apps' microphone use, never capture audio.

### Outstanding Questions

**Resolve Before Planning**

- Feasibility: confirm that macOS exposes which app holds the microphone to a background process without TCC prompts. If it does not, automatic detection is not buildable as specified and the trigger has to change.
- How the desktop apps' own events reach Echo today. The repo has no desktop-app adapter, and `echo_ask` registration covers Claude Code, Pi, and omp only. Once that path is known, decide whether those app-originated notifications get no Echo output at all, given the apps play their own sounds.

**Deferred to Planning**

- The macOS mechanism for detecting per-app microphone use, and the identifiers used to name apps in the list (bundle id versus display name).
- How quickly Echo switches back after the conversation ends, so short pauses do not flip modes back and forth.

### Sources / Research

- Existing capture guard that holds speech while VoiceBar records: `core/capture-guard.ts`.
- Microphone and TCC constraints on background processes: [docs/converse.md](../converse.md).
- `echo_ask` tool registration: `adapters/mcp/server.ts`.
- Existing per-session live-mode suppression in omp and Codex: [docs/adapters.md](../adapters.md) (Live-session voice suppression).
