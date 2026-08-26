# Operations

How to run Echo day to day: start, stop, restart, status, logs, health, updating after a
`git pull`, and recovering after a repo move. Installing is covered in
[`install-human.md`](install-human.md); developing against a second instance in
[`development.md`](development.md).

Service identity:

- LaunchAgent label: `com.echo`
- Plist: `~/Library/LaunchAgents/com.echo.plist`
- Log: `~/Library/Logs/echo.log`

Run all commands from the repo root.

## The everyday four

`cli/echo` is the stable human surface; the scripts below it stay available and are what it
calls. In the order you need them:

1. **Install or update** - `cli/echo update` after a `git pull`, `cli/echo install --adapter <host>`
   the first time or to rewire an adapter. See [Update after a `git pull`](#update-after-a-git-pull).
2. **Check health** - `cli/echo doctor`. See [Doctor](#doctor).
3. **Mute and unmute** - `cli/echo mute on|off|toggle|status` or a duration like `30m`.
   Inside Claude Code, Pi, or omp, `/echo-mute` is the same command.
   See [Mute](#mute).
4. **Set the persona** - `/echo-voice [name] [voice]` inside the project, in your host.
   See [`voices.md`](voices.md#per-project-persona--voice-local-override).

## Doctor

```bash
cli/echo doctor
```

The canonical "did my install work" check. It prints one row per check - platform, `bun`,
converse dependencies, staged payload version, LaunchAgent, service, health, providers, and
adapter registrations - and a healthy run ends with:

```
Result: READY
```

A failing row prints its own recovery command indented underneath it, and the run ends with
`Result: DEGRADED - fix the ✗ rows above, then rerun: echo doctor`, exiting non-zero. The
`payload` row reports which daemon payload is staged (`v0.10.0` on the current release).

## Start

```bash
bash scripts/start.sh
```

Prints `OK echo started on :3246`. If the service is already loaded it says so and exits;
if the plist is missing it tells you to run `scripts/install.sh` first.

## Stop

```bash
bash scripts/stop.sh
```

Prints `OK echo stopped`. If Echo's port is still in use afterwards, the script warns and
deliberately does **not** kill the owner - it may belong to another service. Never
broad-kill whatever owns that port.

## Restart - two idioms

```bash
bash scripts/restart.sh                        # stop + start, ends with a health check
launchctl kickstart -k "gui/$UID/com.echo"     # one-shot in-place restart
```

Both work. `restart.sh` unloads and reloads the LaunchAgent and verifies health;
`kickstart -k` is the quick one-liner - follow it with the health check below if you want
confirmation. Neither picks up an edit to `core/` or `shared/` in your checkout: both reload
the staged payload, so a source or `voices.json` change needs `cli/echo update` (see
[Update after a `git pull`](#update-after-a-git-pull)).

## Status

```bash
bash scripts/status.sh
```

Shows the `launchctl` entry for `com.echo`, warns about still-loaded legacy services,
runs a health check, and prints the log path with the last five log lines.

## Health

```bash
curl -fsS http://localhost:3246/health
```

Returns JSON containing `"status":"healthy"`. Every command on this page uses the port
from `config.json` through `scripts/echo-port.sh`, defaulting to `3246`; a live `PORT` is a
deprecated one-release fallback that warns and cannot override config.json - isolated
instances point `ECHO_CONFIG_FILE` at a scratch config instead. The CLI does not discover
arbitrary listeners. See [`configuration.md`](configuration.md).

## Verify a native terminal notification

`curl -X POST /notify` is a raw HTTP caller, so it intentionally exercises the legacy macOS
notification fallback. Native delivery belongs to a host adapter: the adapter tries Herdr,
then a safe controlling TTY (Ghostty/WezTerm OSC 777, Kitty OSC 99, or iTerm2 OSC 9), and only
sets `visual_delivery: "native"` after one of those routes reports success. The daemon then
skips its AppleScript banner exactly once. See [`http-api.md`](http-api.md#native-terminal-visual-delivery)
for terminal limits, tmux passthrough, SSH/headless behavior, and the adapter-level diagnostic.

Run a direct adapter-client smoke from the adapter package root and from the terminal that owns
the adapter's TTY (not from a pipe, SSH headless shell, or hook-protocol stdout):

```bash
cd adapters/pi
bun -e '
import { sendNotification } from "@echo/shared/notify-client.ts";
import { nativeContextFromAdapterContext } from "@echo/shared/terminal-notify.ts";
const id = `terminal-check-${Date.now()}`;
const result = await sendNotification(
  { endpoint: "http://localhost:3246/notify", title: "Echo native check", voiceEnabled: false },
  "Echo native terminal check",
  "terminal-check",
  id,
  undefined,
  nativeContextFromAdapterContext({}, process.env, id, true),
);
console.log(JSON.stringify({ status: result.status, visual: result.visual, body: result.body }, null, 2));
'
```

The expected HTTP status is `202`. Confirm `visual.status` is `"shown"` and its route is
`"herdr"` or `"terminal"`; an unavailable result means the request correctly retained the
legacy fallback. Verify service state with `cli/echo doctor`, `cli/echo status`, and
`curl -fsS http://localhost:3246/health`. A spoken check uses the ordinary `/notify` request
with `voice_enabled: true`; verify its eventual `played` disposition in the audio-lifecycle
log because `202` means accepted, not finished speaking.

### Verified WezTerm capture

For a visual acceptance test, run the adapter smoke from a real WezTerm TTY. If the terminal
is focused and its notification policy suppresses focused-pane notifications, use a temporary
isolated process with a test-only Echo config selector; do not edit the global WezTerm config:

```bash
mkdir -p ~/.config/echo
cat > ~/.config/echo/wezterm-test.json <<'JSON'
{"ECHO_VOICE_ENABLED":false,"ECHO_VOICE_GREET_ON_START":true,"ECHO_VOICE_SPEAK_COMPLETIONS":false}
JSON
/Applications/WezTerm.app/Contents/MacOS/wezterm \
  --config 'notification_handling="AlwaysShow"' \
  start --always-new-process --no-auto-connect --cwd "$PWD" -- \
  env ECHO_CONFIG_FILE="$HOME/.config/echo/wezterm-test.json" \
  HERDR_SOCKET_PATH=/dev/null PI_OFFLINE=1 \
  pi --no-session --offline --no-tools -e "$PWD/adapters/pi/index.ts"
rm ~/.config/echo/wezterm-test.json
```

The rollout capture was made from the real terminal path with WezTerm
`20260716-195552-76b606ec` on macOS, Echo `0.7.1` staged payload (the then-current release;
native-delivery behavior is unchanged in v0.10.0), and Pi `0.82.1`. The adapter
selected terminal-native WezTerm OSC 777 delivery (`visual: {status: "shown", route:
"terminal", terminal: "wezterm"}`); the exact native marker suppressed the AppleScript
fallback. The temporary window was closed after capture and the global WezTerm configuration
was unchanged.

![Real WezTerm native notification](assets/notifications/wezterm-native-pi.png)

*Real native terminal notification captured from Pi: title `Echo WezTerm`, message `Native
WezTerm capture`. The image is deliberately cropped to the notification and contains no
unrelated terminal content.*

If a voice test is not heard, check the host output device and volume before diagnosing Echo:
the original External Headphones route at 6% was not audible, while the same accepted test was
heard clearly through Mac Studio Speakers at 35%; the original headphones route and 6% volume
were then restored. This counterfactual isolates host output masking from Echo synthesis.

## Logs

- Server log: `~/Library/Logs/echo.log` - `tail -f` it while debugging.
- Voice-resolution log: `~/Library/Logs/echo/voice-resolution.jsonl` - records how each
  notification's requested voice resolved, including fallbacks and provider diagnostics
  (`phase`, `reason`, timeout, exit code, stderr). Details in
  [`providers-observability.md`](providers-observability.md).

## Mute

Runtime mute turns the audio off while notifications are still accepted, processed, and
logged, across every provider. `cli/echo mute` is the command to use:

```bash
cli/echo mute status    # current state, e.g. {"mute":{"muted":false,"muted_until":null}}
cli/echo mute on        # mute indefinitely
cli/echo mute off       # unmute now
cli/echo mute toggle    # flip state
cli/echo mute 30m       # timed mute; `1h` and a bare number of minutes also work
```

Each command prints the resulting state as JSON. Mute state survives daemon restarts, deadline
included - the state-file location and its `ECHO_MUTE_STATE_PATH` override are in
[`configuration.md`](configuration.md). A timed mute expires silently: voice simply resumes on
the next notification.

**Mute is machine-wide, not per session.** One Echo daemon serves the whole machine on the
configured port (default `:3246`), so muting it silences Echo audio for *every* agent, script,
and terminal that speaks through it - not only the session you typed the command in. Any other
agent can unmute it just as easily. `cli/echo mute status` is the way to find out which state
you are actually in.

**Mute only silences audio Echo produced.** In v0.10.0, live chat (Oh My Pi `/live`) speaks
through its own audio path and keeps talking while Echo is muted; muting Echo removes the
spoken completion line layered on top of it, not the live voice itself.

**Host slash command.** Claude Code, Pi, and omp also expose `/echo-mute [on|off|toggle|status|duration]`.
It runs `cli/echo mute` (empty args → `toggle`) and does not add a second mute path.

### The underlying script

`cli/echo mute` wraps `scripts/mute.sh`, which wraps `POST /mute` on the configured port. It
takes minutes rather than a duration string, and remains available:

```bash
bash scripts/mute.sh status
bash scripts/mute.sh on        # indefinite
bash scripts/mute.sh on 30     # 30 minutes
bash scripts/mute.sh off
bash scripts/mute.sh toggle    # same as an empty POST /mute
```

For an isolated test instance, point `ECHO_CONFIG_FILE` at a scratch config containing `PORT`.
The `/mute` endpoint contract and one-keystroke hotkey bindings (Raycast, Apple Shortcuts,
Stream Deck) are in [`http-api.md`](http-api.md).

## Update after a `git pull`

Bun runs the TypeScript sources directly - there is no build step. **But the daemon runs
from a staged payload copy** (`~/Library/Application Support/echo/payload/versions/<v>`), not the
checkout, so editing `core/`/`shared/` and merely restarting keeps running the *old* payload.
To pick up daemon-source or config changes, re-stage:

```bash
cli/echo update                          # re-stage the payload from this checkout + reload
cli/echo install --adapter claudecode    # first install, or to (re)wire a host adapter
# the scripts underneath: bash scripts/install.sh --adapter <none|claudecode|jcode|grok|codex|mcp|pi|omp>
```

- Daemon source or config change (`core/`, `shared/`, `core/voices.json`) → `cli/echo update`.
- Adapter-only change (`adapters/`, registration behavior) → rerun the installer with your
  adapter; it is idempotent and re-reconciles every other installed adapter too.

A re-stage is reversible: the payload that was running is kept aside until the reloaded
daemon answers `/health`. If it does not, the installer repoints `current` back at that copy
and reloads it, so a bad update leaves you on the daemon you had rather than a crash-looping
one, and exits 1 with the log path. It re-checks health after the restore too, and says
`ROLLBACK INCOMPLETE` rather than claiming success if even the old payload stays down.

## Which config changes need a re-stage

The daemon reads all three of its config files once at startup, but they do **not** live in the
same place:

- `~/.config/echo/config.json` is resolved from your home directory, never from the payload.
  Edit it and reload - `launchctl kickstart -k "gui/$UID/com.echo"` is enough; no re-stage.
- `core/voices.json` and `core/pronunciations.json` are resolved next to the running
  `core/server.ts`, which is **the payload copy**. Editing the checkout's copy has no effect
  until you re-stage: edit, then `cli/echo update` (it re-stages and reloads).

## Moved or renamed the repo?

The daemon no longer cares: its LaunchAgent points at the clone-independent payload, so a
checkout move or removal leaves the running service untouched. Only the **adapter
registrations** still point at the checkout and get stranded by a move. Rerun the installer
once with any `--adapter` value - it re-reconciles every installed adapter registration (and
re-stages the payload from the new location):

```bash
bash scripts/install.sh --adapter <none|claudecode|jcode|grok|mcp|pi|omp>
```

To audit without changing anything (`cli/echo doctor` wraps this and explains each row):

```bash
bash scripts/install.sh --check      # or: cli/echo doctor
```

Exit 0 when everything is current; exit 3 with `Stale paths found` on stderr when
anything is stale (a deleted payload shows as a dead plist path). `--check` prints
one section per harness (`Checking <name>`), with `[x]` / `[\]` / `[ ]` for
complete, partial, and missing LaunchAgent, workspace link, and adapter
registration. The harness name is bold palette cyan on a color TTY.
`cli/echo doctor` agrees
on the verdict but not the number: it folds this check into its `registrations` row and
exits **1** (`Result: DEGRADED`) for the same state, so scripts should test for non-zero
rather than a specific code. Three caveats: `--check` verifies the plist's server path and
working directory but not the embedded `bun` binary path (after relocating a Bun install,
rerun the installer); it checks only that paths still *resolve*, never that the staged
payload's contents match this checkout, so a payload staged from older source at the same
version reports current (re-stage with `cli/echo update` after editing `core/`/`shared/`);
and per-adapter exit codes fold into the aggregate 0/3 result - the full per-adapter
exit-code contract lives in [`adapters.md`](adapters.md).

## Uninstall

```bash
bash scripts/uninstall.sh          # or: cli/echo uninstall  (--check previews it)
```

Removes the LaunchAgent **and the daemon payload**, preserving logs (`~/Library/Logs/echo.log`)
and persona config (`~/.config/echo/config.json`). Adapter registrations are **not** removed:
Claude Code hook entries in `~/.claude/settings.json`, the `echo-mute.md` and `echo-voice.md`
symlinks in `~/.claude/commands/`, the `echo-converse` MCP server in `~/.claude.json`, Jcode's
`turn_end` and `session_start` entries in `~/.jcode/config.toml`, Grok Build's
`~/.grok/hooks/echo-voice.json`, the Pi `packages` entry in `~/.pi/agent/settings.json`, and the
omp `echo-voice` symlink in `~/.omp/agent/extensions/` all survive. There is no deregistration
tool; remove those entries by hand before deleting the repo directory, or hosts will keep
pointing at dead paths.

## Legacy services

The installer migrates the old `com.pai.voice-server` and `com.atlas.voicesystem`
LaunchAgents onto `com.echo` (it unloads them and quarantines their plists). Do not
reload them; if `status.sh` warns that one is still loaded, rerun the installer.
