---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
date: 2026-07-10
status: requirements-only
---

# Voice Playback Serialization - Plan

## Goal Capsule

- **Objective:** Stop voice notifications from playing over each other. One voice at a time,
  globally — a new turn never talks over an in-progress one — while staying responsive (callers
  ack immediately, don't block on playback).
- **Product authority:** Ed.
- **Open blockers:** None. Exact thresholds (age cap, depth cap) are tunable knobs, not blockers.

## Context

Phase 2 of the voice work (plan `docs/plans/2026-07-09-001-fix-voice-drop-observability-plan.md`,
Phase 1 merged #89/#90). Phase 1's audio-lifecycle log **confirmed** the real defect: the daemon
(`core/server.ts`) has no playback serialization, so concurrent `/notify`s each spawn their own
`afplay` and play simultaneously (measured ~8 s of overlap; Ed: *"overlapping conversations,
talking over each other"*). This — not single-clip truncation (R4 proved clips play to
completion) — is what read as "cut off." This plan resolves the concurrency behavior; `ce-plan`
owns the implementation.

## Product Contract

### R1 — Global serial playback

One voice plays at a time across **all** sessions and hosts (Claude Code hooks, Pi, omp, the
mute script). A new line never starts while another is playing. Serialization is global, not
per-session — per-session would leave cross-session overlap, which is the whole problem.

### R2 — Ack on receipt, play async (`202`)

`/notify` returns as soon as the request is validated and accepted; synthesis and playback run
asynchronously from the queue. Callers stop blocking on playback (measured: greeting hook ~6.8 s
→ ~ms; Stop hook ~9–12 s → ~ms). This is the validated `202`-on-receipt change, shipped *with*
the queue (bare fire-and-forget without a queue would worsen overlap — never ship it alone).

### R3 — Queue, don't interrupt

When a line arrives during playback it is **queued**, not played over the top, and the current
line always finishes. No barge-in, no priority lanes in v1.

### R4 — Newest-per-session coalescing

Queued lines coalesce by `session_id`: a session's newer line **replaces** its older *queued*
line (you hear each active agent's latest, not its backlog). Coalescing affects only the queue,
never the currently-playing line. Lines with no `session_id` don't coalesce but still serialize
and age-cap.

### R5 — Age cap on stale lines

A queued line that has waited too long (age measured from receipt) is **dropped** rather than
played late, so you never hear an ancient "standing by." Threshold is a tunable knob.

### R6 — Respects mute; can't deadlock

Muted state still suppresses (unchanged). A stuck/hung playback can't stall the queue: each play
stays bounded by the existing `afplay` process timeout, and the queue advances on that bound.

### R7 — Verifiable via disposition logging

The Phase 1 audio-lifecycle record gains a `disposition` per line — `played` / `dropped-stale` /
`superseded` (coalesced away) — plus the existing play-window timestamps. Success is
**observable**: two overlapping requests record **non-intersecting** `play_started_at` /
`play_ended_at` windows, and drops show a reason.

### Success criteria

- A rapid burst of turns from multiple concurrent agents is heard **one at a time, in full** —
  no overlap. Verified from the audio-lifecycle log: no intersecting play windows.
- Callers return in milliseconds (`202`), not after playback.
- Under many chatty agents, you hear each one's *latest* line, bounded — no growing backlog,
  no ancient lines.
- `bun test` + smoke + Pi build pass; mute still suppresses.

### Scope boundaries

**In:** daemon-side global serial queue + coalescing + age cap; `202`-on-receipt; disposition
logging.

**Out (v1):** priority/barge-in lanes; per-host or per-session policies; cross-machine
coordination; changing *which* turns speak or *what* text is chosen (that's the untouched
selection path).

### Constraints (AGENTS.md)

- `core/` stays host-neutral — the queue is generic playback ordering, no host-specific logic.
- **`/notify` contract change** (200-after-playback → 202-on-receipt) needs an explicit
  compatibility note in the plan: it stays 2xx (`response.ok` remains true) and current callers
  only log the status rather than branching on it, so no caller breaks — but the semantic shifts
  from "delivered" to "accepted," and the true playback outcome now lives in the audio-lifecycle
  log, not the HTTP response.

### Accepted tradeoff

Under fast sequential turns from a *single* agent, intermediate lines may be skipped
(coalesced/aged out) — the deliberate flip side of R4/R5. Acceptable: that agent's text is on
screen, and hearing its whole backlog is exactly the pile-up we're removing.

## Outstanding Questions (for `ce-plan` / implementation)

- Age-cap and any depth-cap **default values** (and their `ECHO_*` env overrides).
- Whether disposition logging extends the existing `audio-lifecycle.jsonl` schema or adds queue
  events — a `ce-plan` call, informed by the Phase 1 module.
- Whether this supersedes the `202` Outstanding Questions in the Phase 1 plan or cross-links them
  (both now point here).
