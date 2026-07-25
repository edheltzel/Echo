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
deliberately does **not** kill the owner — it may belong to another service. Never
broad-kill whatever owns that port.

## Restart — two idioms

```bash
bash scripts/restart.sh                        # stop + start, ends with a health check
launchctl kickstart -k "gui/$UID/com.echo"     # one-shot in-place restart
```

Both work. `restart.sh` unloads and reloads the LaunchAgent and verifies health;
`kickstart -k` is the quick one-liner — follow it with the health check below if you want
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
from `config.json` through `scripts/echo-port.sh`, defaulting to `3246`; a live `PORT`
override is available for one isolated command or test. The CLI does not discover arbitrary
listeners. See [`configuration.md`](configuration.md).

## Logs

- Server log: `~/Library/Logs/echo.log` — `tail -f` it while debugging.
- Voice-resolution log: `~/Library/Logs/echo/voice-resolution.jsonl` — records how each
  notification's requested voice resolved, including fallbacks and provider diagnostics
  (`phase`, `reason`, timeout, exit code, stderr). Details in
  [`providers-observability.md`](providers-observability.md).

## Mute

`scripts/mute.sh` wraps `POST /mute` on the configured port (default `:3246`; exporting
`PORT` aims it at one specific daemon, e.g. an isolated test instance). While muted,
notifications are still accepted,
processed, and logged — only the audio is suppressed, across every provider:

```bash
bash scripts/mute.sh status    # prints the current state, e.g. {"mute":{"muted":false,"muted_until":null}}
bash scripts/mute.sh on        # mute indefinitely
bash scripts/mute.sh on 30     # mute for 30 minutes, then auto-resume
bash scripts/mute.sh off       # unmute now
bash scripts/mute.sh toggle    # flip state — same as an empty POST /mute
```

Each command prints the resulting state as JSON. Mute state survives daemon restarts,
deadline included — the state-file location and its `ECHO_MUTE_STATE_PATH` override are in
[`configuration.md`](configuration.md). A timed mute expires silently: voice simply resumes
on the next notification. The `/mute` endpoint contract and one-keystroke hotkey bindings
(Raycast, Apple Shortcuts, Stream Deck) are in [`http-api.md`](http-api.md).

## Update after a `git pull`

Bun runs the TypeScript sources directly — there is no build step. **But the daemon runs
from a staged payload copy** (`~/Library/Application Support/echo/payload/versions/<v>`), not the
checkout, so editing `core/`/`shared/` and merely restarting keeps running the *old* payload.
To pick up daemon-source or config changes, re-stage:

```bash
cli/echo update                 # re-stage the payload from this checkout + reload
# equivalently: bash scripts/install.sh --adapter <none|claudecode|pi|omp>
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
  Edit it and reload — `launchctl kickstart -k "gui/$UID/com.echo"` is enough; no re-stage.
- `core/voices.json` and `core/pronunciations.json` are resolved next to the running
  `core/server.ts`, which is **the payload copy**. Editing the checkout's copy has no effect
  until you re-stage: edit, then `cli/echo update` (it re-stages and reloads).

## Moved or renamed the repo?

The daemon no longer cares: its LaunchAgent points at the clone-independent payload, so a
checkout move or removal leaves the running service untouched. Only the **adapter
registrations** still point at the checkout and get stranded by a move. Rerun the installer
once with any `--adapter` value — it re-reconciles every installed adapter registration (and
re-stages the payload from the new location):

```bash
bash scripts/install.sh --adapter <none|claudecode|pi|omp>
```

To audit without changing anything (`cli/echo doctor` wraps this and explains each row):

```bash
bash scripts/install.sh --check      # or: cli/echo doctor
```

Exit 0 when everything is current; exit 3 with `Stale paths found` on stderr when
anything is stale (a deleted payload shows as a dead plist path). `cli/echo doctor` agrees
on the verdict but not the number: it folds this check into its `registrations` row and
exits **1** (`Result: DEGRADED`) for the same state, so scripts should test for non-zero
rather than a specific code. Three caveats: `--check` verifies the plist's server path and
working directory but not the embedded `bun` binary path (after relocating a Bun install,
rerun the installer); it checks only that paths still *resolve*, never that the staged
payload's contents match this checkout, so a payload staged from older source at the same
version reports current (re-stage with `cli/echo update` after editing `core/`/`shared/`);
and per-adapter exit codes fold into the aggregate 0/3 result — the full per-adapter
exit-code contract lives in [`adapters.md`](adapters.md).

## Uninstall

```bash
bash scripts/uninstall.sh          # or: cli/echo uninstall  (--check previews it)
```

Removes the LaunchAgent **and the daemon payload**, preserving logs (`~/Library/Logs/echo.log`)
and persona config (`~/.config/echo/config.json`). Adapter registrations are **not** removed:
Claude Code hook entries in `~/.claude/settings.json`, the Pi `packages` entry in
`~/.pi/agent/settings.json`, and the omp `echo-voice` symlink in
`~/.omp/agent/extensions/` all survive. There is no deregistration tool; remove those
entries by hand before deleting the repo directory, or hosts will keep pointing at dead
paths.

## Legacy services

The installer migrates the old `com.pai.voice-server` and `com.atlas.voicesystem`
LaunchAgents onto `com.echo` (it unloads them and quarantines their plists). Do not
reload them; if `status.sh` warns that one is still loaded, rerun the installer.
