# Jev decision seats (#194)

Spike only. No code, no API call, no signup. Jev is TypeSafe's hosted System One model: send state and typed questions, get structured answers, not generated text (https://docs.typesafe.ai/introduction). It is early access, not a local binary (https://typesafe.ai/blog/introducing-system-one-models-and-jev). If Jev is unset, slow, or wrong, Echo keeps today's rule.

- Interrupt / duck: no-go. Echo hard-waits. Do not put a hosted call on the speak path.
- Mute gate: no-go to ship. Mute is manual. Jev cannot see focus, a call, or idle time.
- Wake vs ignore: no-go. No always-on listener. Jev takes text only, and a transcript must not leave the host.

## 1. Interrupt / duck

Talk over playback, wait, or cut.

**Today.** Echo makes no such decision. `PlayQueue.enqueue` (`core/play-queue.ts`) replaces a queued job with the same `sessionId` (`superseded`, reason `newer-line-same-session`) and does not touch the in-flight job (R3, no barge-in). `consume` drops a job older than `ageCapMs` at dequeue (`dropped-stale`, `age-cap-exceeded`; default 300000 ms via `ECHO_PLAY_QUEUE_AGE_CAP_MS`). There is no volume duck and no stop of the player that is already running. `writePlaybackState` (`core/playback-state.ts`) only publishes `idle` or `speaking` plus `queue_depth`. `speakWithFallback` (`core/server.ts`) may return `held_for_capture` before any provider when `captureReservationHeld` (`core/playback-reservation.ts`) or `isCaptureActive` (`core/capture-guard.ts`) is true. That skips a line that has not started. It does not cut one already playing.

**What Jev would add.** A decision the queue currently refuses. One Choice, `wait` | `cut` | `talk_over` (https://docs.typesafe.ai/introduction). State is JSON text, which is an accepted input (https://docs.typesafe.ai/concepts/system-one):

```json
{ "playback": "speaking", "in_flight_ms": 0, "queue_depth": 0, "same_session": true, "age_ms": 0, "slot": "generic", "capture_active": false }
```

No message text. The introduction table says Choice returns `choice`, `probabilities`, and `confidence` (https://docs.typesafe.ai/introduction). Sample values on the system-one page are illustrative, and the primitive page was not read (https://docs.typesafe.ai/concepts/system-one). Code acts on `cut` or `talk_over` only when confidence is high enough to leave the wait rule. Otherwise wait (https://docs.typesafe.ai/concepts/system-one).

**Constraints.** The call is hosted: client SDK or `POST /v1/systemone`, `model` such as `jev-latest` (https://docs.typesafe.ai/concepts/system-one). That is new egress. Echo is localhost-only. Default `edgetts` already sends spoken text to Microsoft; a disabled provider makes zero calls (`SECURITY.md`, `docs/providers-observability.md`). A Jev client must stay off unless explicitly enabled, same structural gate, and must not run from the player. Their published end-to-end time is 70-500 ms, from laptops on the West Coast, where they say the service is based (https://typesafe.ai/blog/introducing-system-one-models-and-jev). This spike did not measure it. Blocking playback on that number misses a duck. Offline, timeout, or error: keep R3. Do not send notification text, transcripts, or secrets. Converse already refuses to send a transcript to its own coordinator (`SECURITY.md`). Input is listed at $0.042 / MTok and output as free; they say they cannot prove the price is unsubsidized (same blog). Group calibration does not make one answer correct (https://docs.typesafe.ai/concepts/system-one). Their "cannot hallucinate" line is a schema-match guarantee, not a claim this spike checked (same blog).

**Proof.** One fixture in, one decision out, no network. Input: `{ "playback": "speaking", "same_session": true }`. Mock Choice `cut`. Assert the harness records `cut` and does not call `PlayQueue` or start playback. A thrown mock must record `wait`. **No-go.** Ship nothing until that harness exists and a later change has a local cut or duck. Jev does not create that primitive.

## 2. Mute gate

Auto mute or unmute from focus, a call, or AFK. Not a second manual `mute`.

**Today.** The only mute decision is the operator's. `setMuteState`, `toggleMuteState`, and `readMuteState` (`core/mute.ts`) persist `{ muted, muted_until, scope }` with scope `tts`, `mic`, or `all`. Missing file, or `{ muted: false, scope: "all" }`, is unmuted. A timed mute expires lazily inside `readMuteState`. `speakWithFallback` calls `isTtsMuted` before providers. `isMicMuted` rejects a capture reservation (`core/server.ts`). `assessCore` (`converse/playback.ts`) refuses `echo_ask` when the speaker is muted or scope is `mic`. The CLI is `cmd_mute` in `cli/echo`, which execs `scripts/mute.sh`. Hosts call `createEchoMuteCommand` (`shared/mute-command.ts`), which shells that CLI. `POST /mute` is the daemon write. Nothing in that path reads focus, a meeting, or idle time. `readOutputMode` (`core/output-mode.ts`) is a separate operator switch (`speech` | `sounds`), also not context. Issue #126 (Meet, Teams, Zoom, and two more) is open. Ed's note: it sits outside notify/adapter core, needs a meeting, calendar, or audio-scene signal, and needs a design (what a meeting is, who detects it, mute vs hold) before it is actionable. The auto-quiet plan (`docs/plans/2026-10-07-1549-feat-auto-quiet-voice-conversation-plan.md`) is paused on whether a background process can see which app holds the microphone. It is not code.

**What Jev would augment.** Not the sensor. Jev accepts strings, JSON objects, and arrays of text. Images, audio, and video are not supported (https://docs.typesafe.ai/concepts/system-one). A Choice (`mute_tts` | `mute_all` | `unmute` | `hold`) or one Noul per condition can run only after local code has already filled booleans. State shape:

```json
{ "focus_class": "other", "meeting_app": false, "idle_s": 0, "scope": "all", "muted": false, "sounds_only": false }
```

`focus_class` is an enum the probe maps locally (`zoom`, `meet`, `teams`, `other`). Never send window titles, meeting names, calendar text, or notification text. Noul returns `noul` in 0-1. Choice returns `choice`, `probabilities`, and `confidence` (https://docs.typesafe.ai/introduction). Several questions can share one call and are evaluated in parallel against the same state (same page). Code, not the model, combines them (same page). The only judgment a model might earn is a fuzzy one, such as "listed app is frontmost but may not be in a call", and only after the probe exists.

**Constraints.** Same hosted egress and early-access dependency (https://docs.typesafe.ai/concepts/system-one, https://typesafe.ai/blog/introducing-system-one-models-and-jev). Key in env, never in the repo; `/health` may report configured true or false, never the key (`SECURITY.md` ElevenLabs pattern). A failed or offline call must not mute and must not unmute. Leave `readMuteState` as the operator left it. That is fail-closed for a control they already own. This seat can poll. It still must not sit inside `speakWithFallback`. Published price is input tokens only (blog URL above). Do not write the state payload to the resolution log if a future probe leaks a title into it.

**Proof.** One fixture, no network, no `setMuteState`. Input: `{ "meeting_app": true, "muted": false }`. Mock Choice `mute_tts`. Assert the harness records `mute_tts` and does not write mute state. A thrown mock records `hold`. **No-go to ship.** Revisit only after a local probe can set `meeting_app` without a model. If that probe is a hard bundle-id match, Jev is still unnecessary.

## 3. Wake vs ignore

Real ask, ambient noise, or nothing.

**Today.** Echo makes no such decision. There is no wake word and no always-on microphone. The mic opens only when a host calls `runAskTool` (`converse/host-tool.ts`) and `SessionConsent.ensure` (`converse/session-consent.ts`) returns `granted`. Any other consent result returns before capture. `assessCore` then refuses a muted, busy, or guard-disabled core. Once recording, `recorderArgv` (`converse/capture.ts`) is sox `silence` with `1 0.1 2%` then `1 <silenceSeconds> 2%`: trim lead-in, stop after trailing silence. Windows live in `SILENCE_MODE_MS` (`converse/silence-mode.ts`): quick 500, standard 1500, thoughtful 2500. `captureAndTranscribe` throws `no_speech` when the wav is under `MIN_AUDIBLE_WAV_BYTES` (1024) or the local transcript is empty. That is an empty-file check, not a classifier. Speech during a booked turn, ambient or not, is transcribed and returned to the calling host. The coordinator stores `transcript_chars` only (`TurnCompletion` in `converse/types.ts`).

**What Jev would need, and does not get.** Audio is unsupported (https://docs.typesafe.ai/concepts/system-one). A Noul such as "is this a real ask?" needs the words or the sound. Sending the transcript would break local-only STT: "a spoken answer never leaves the host" (`SECURITY.md`). Duration, byte length, silence mode, and "consent already granted" do not separate a real ask from a television. Consent already answered "may we listen for this turn." A Choice of `ask` | `ambient` | `nothing` with no legal state is not a seat. Jev also does not write an explanation of the choice (https://docs.typesafe.ai/concepts/system-one), so it cannot be a second-pass reviewer of a transcript we are unwilling to send.

**Constraints.** Hosted `POST /v1/systemone`, early access, vendor latency 70-500 ms, offline fails closed (https://docs.typesafe.ai/concepts/system-one, https://typesafe.ai/blog/introducing-system-one-models-and-jev). On an unsolicited path, fail-closed means do not open the mic. That path does not exist today, and this spike must not add an always-on recorder to manufacture state. Same privacy rule as seat 1: no transcript, no secrets, no new egress of spoken words (`SECURITY.md`, `docs/providers-observability.md`).

**Proof.** Do not call Jev. The local rule already covers the empty case: wav under 1024 bytes is `no_speech`. A fixture `{ "capture": "booked", "wav_bytes": 100 }` must resolve to `nothing` with no mock client imported. **No-go.**

## Not checked

- No request to `POST /v1/systemone`. Latency, price, and early-access availability are vendor text, not measurements from this machine.
- `/primitives/choice`, `/primitives/score`, `/primitives/noul`, `/confidence`, and `/api` were not fetched. Return names above are the introduction table. The system-one page marks its sample values as illustrative.
- The blog's schema-match guarantee was not tested. A typed `choice` can still be the wrong action (https://docs.typesafe.ai/concepts/system-one).
- Whether macOS will tell a background process which app holds the microphone is still the open blocker in the auto-quiet plan. This spike did not probe it.
