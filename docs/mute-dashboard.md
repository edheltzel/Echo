# Mute, snooze, and the dashboard

Someone sat down nearby, a call is starting, or you want a quiet hour. Echo has one mute switch for
the whole machine, a snooze that ends on its own, a sounds-only mode, and a local control page.
Muting keeps the daemon running: notifications are still accepted and logged, they just make no
sound. Taking the daemon down is a different thing; see
[Mute vs daemon disable](operations.md#mute-vs-daemon-disable).

## Mute

```bash
cli/echo mute on           # speaker and microphone, until you turn it off
cli/echo mute off          # unmute now
cli/echo mute 30m          # snooze for 30 minutes; `1h` works too
cli/echo mute until 15:30  # snooze to that local time; tomorrow if it has already passed
cli/echo mute on tts       # speaker only: notifications play as sounds instead of speech
cli/echo mute on mic       # microphone only: blocks voice ask, notifications still speak
cli/echo mute status       # Mute: ON or OFF, plus what is held
```

Mute is machine-wide, not per session. One daemon serves every agent, script, and terminal, so
muting from one session silences all of them, and any of them can unmute. A snooze survives a
daemon restart and ends quietly: the next notification after the deadline speaks again.

Inside a host, the mute command is the same switch: `/echo-mute` where the host has slash
commands, or the `$echo-mute` skill. Every scope, the underlying `scripts/mute.sh`, and what each
host registers are in the [mute reference](operations.md#mute). Why mute is layered, and what
still makes sound while muted, is in [Silence and mute](what-echo-does.md#silence-and-mute).

## Sounds instead of speech

```bash
cli/echo mode sounds   # a short sound for each notification, no speech
cli/echo mode speech   # speak again (the default)
cli/echo mode status
```

Echo plays a request sound when an agent needs you, a done sound when it finishes, and a generic
sound for everything else. The mode is global and survives restarts. Which sound plays when, and
how to use your own files: [Sounds instead of speech](what-echo-does.md#sounds-instead-of-speech).

## Dashboard

```bash
cli/echo dashboard           # open http://localhost:3246/ in the browser
cli/echo dashboard --print   # print the URL without opening it
```

The daemon serves a local control page on its own port. From it you can:

- see whether Echo is muted and whether the daemon is healthy, and list the configured voices;
- mute now, or snooze all notifications for a duration or until a date and time;
- wake now, which ends a mute or snooze early;
- switch the output mode between speech and sounds;
- replay recent lines;
- read your `config.json` with secret-looking keys redacted. `.env` is never read.

Snooze on the dashboard is the same machine-wide mute as `cli/echo mute`, so it covers every agent
at once.

The page answers only loopback requests addressed to `localhost` or `127.0.0.1` on the daemon's
port, and its buttons reject requests from other browser origins. That is a guard, not a login:
any local process can still call the same endpoints. Details:
[Dashboard and the same-origin guard](http-api.md#dashboard-and-the-same-origin-guard).

### Themes

The dashboard has four themes: Neutral (the default), High contrast, Cool slate, and Warm amber.
Each comes in light and dark; light or dark follows your system setting until you pick one, and
the browser remembers your choice.
