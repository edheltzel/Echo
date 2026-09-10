# What Echo does

Echo is ambient completion audio for coding agents. When a turn ends, a short line is spoken so you can keep your eyes on the work.

It is a local daemon on your Mac. Hosts do not import it. They POST JSON to `localhost:3246/notify`. A `curl` is a valid host.

This page says what Echo is, when it speaks, when it stays quiet, and how to keep a shared office quiet. Install and first sound live in [Hear your first spoken notification](getting-started.md). Commands live in [operations.md](operations.md). The wire contract is [http-api.md](http-api.md).

## What it is not

Echo is not a conversation loop. It does not sit in a listen-speak-listen cycle as its core job.

Echo is not a menu-bar recorder, a notch UI, or a global push-to-talk chrome.

First-class speech-to-text is [roadmap (#179)](https://github.com/edheltzel/Echo/issues/179). The optional one-shot voice ask (`echo-converse`) can speak one question and return one spoken reply. That is extra. It is not why you install Echo.

## When it speaks

A request becomes speech only after it reaches the daemon with voice on, the runtime TTS mute is off, and no live capture is holding the speaker.

Typical spoken lines:

- A turn-completion line from a wired host (the trailing `🗣️` line on Claude Code, Pi, oh-my-pi, Jcode, Grok Build, and Codex)
- A session-start greeting, when that host has greetings on (Pi and oh-my-pi default on. Claude Code, Jcode, Grok, and Codex default off.)
- Anything you POST yourself, including the "Hello from Echo" smoke
- A replay of the last N lines that actually played (`cli/echo replay [n]`, default 1, max 10). Muted lines are not held for later replay.

Subagents stay quiet by default. Headless Pi and omp runs (`json` / `print`, or `hasUI === false`) stay quiet. OpenCode does not speak completions. It only exposes mute.

## When it stays quiet

Quiet is a feature. These are the usual reasons you hear nothing:

- No adapter is installed, and nothing POSTed `/notify`
- Runtime mute is on for the speaker (`cli/echo mute on` or `on tts`)
- The adapter has `ECHO_VOICE_SPEAK_COMPLETIONS` off, or greetings off
- `ECHO_VOICE_ENABLED` is false, or this request sent `voice_enabled: false`
- A subagent turn (suppressed by default)
- A capture is in progress. Echo will not talk over an open microphone. The banner can still appear.
- The play queue dropped a stale or superseded line. The request was accepted. The audio was not played.
- Oh My Pi `/live` is talking on its own path. Muting Echo does not stop that live voice. It only stops Echo's completion line on top of it.

Wrong voice is not silence. A request with no `voice_id` uses the identity voice (edge `en-GB-RyanNeural`), logged as `identity-default`. If you hear macOS `say` ("Daniel"), or Ava (`en-US-AvaNeural`, the edge provider `defaultVoice`), the chain did not use identity. That path is in the getting-started troubleshooting section and in [voices.md](voices.md).

## States

These are the states a human can usefully ask about. They are not a second product. `/health` reports several of them.

| State | What you notice | How you see it |
| --- | --- | --- |
| Idle | Daemon up, nothing playing | `/health` is `"healthy"`. `play_queue.in_flight_ms` is null. Mute is off. |
| Speaking | A line is in the speaker | `play_queue.in_flight_ms` is a number. The audio-lifecycle log later records `played`. |
| Muted | Requests succeed, speaker stays off | `cli/echo mute status`. `/health` `mute.muted` is true (`tts` or `all`). |
| Held for capture | Banner may fire, speaker waits | `/health` `capture_guard.state` is not idle. Lifecycle disposition `held-for-capture`. |
| Error | Health fails, or speech falls through the chain | `cli/echo doctor` ends `DEGRADED`. `~/Library/Logs/echo.log` and the voice-resolution log name the provider attempt. |

`202` on `/notify` means accepted, not finished speaking. A muted or capture-held line can still return success or accepted. Prove speech with your ear, then the lifecycle log if you need a machine record.

## Silence and mute

Silence is layered. Use the smallest layer that matches the room.

1. **Do not wire a host.** Core-only Echo speaks only when something POSTs. A shared office with no adapter is already quiet.
2. **Runtime mute.** `cli/echo mute on`, `off`, `toggle`, `status`, or a duration such as `30m`. Default scope `all` (speaker + capture booking). `tts` holds playback only — notifications still processed and logged. `mic` holds capture / converse / `echo_ask` only; TTS may still speak. One daemon serves the machine, so this mutes every Echo session at once. `/echo-mute` on hosts that register it is the same command. Do not invent a second mute system.
3. **Adapter policy.** `ECHO_VOICE_SPEAK_COMPLETIONS`, `ECHO_VOICE_GREET_ON_START`, `ECHO_VOICE_SUPPRESS`, and `ECHO_VOICE_SUPPRESS_SUBAGENTS` in `~/.config/echo/config.json`. This is "this host should not talk," not a meeting switch.
4. **This request.** `"voice_enabled": false` is the silent smoke. Tests use it. You can too.
5. **Capture hold.** While a live pid is recording or transcribing, Echo skips voice so the microphone does not hear the speaker.

Mute survives daemon restarts, deadline included. A timed mute expires on the next notification. There is no per-session mute. Any local process can unmute, because `/mute` is unauthenticated localhost, same as `/notify`.

The state file and hotkey bindings live in [operations.md](operations.md#mute) and [http-api.md](http-api.md).

## Shared offices

Echo is optional per install. Disable it the way that matches how long the room is shared.

- Someone sat down for a meeting. Run `cli/echo mute on`. Unmute when they leave. `30m` if you know the length.
- This machine should not talk at all today. Mute indefinitely, or stop the LaunchAgent with the commands in [operations.md](operations.md).
- This project should not speak. Do not install an adapter in that checkout, or turn completions off in config.
- Uninstalling removes the LaunchAgent and the staged payload. Adapter registrations are not removed. See [install-human.md](install-human.md#uninstall).

Mute is the product answer for a shared office. Do not reach for a second mute system.

## What a host actually sends

Adapters translate host lifecycle into `POST /notify`. They add `source` and `session_id` when they have them. Notify failures are warnings in the host session, never a broken turn.

Persona and voice resolution, including the trap of sending a raw provider id, live in [voices.md](voices.md). Provider egress (edge-tts is online by default) is [providers-observability.md](providers-observability.md).
