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

Prints `OK echo started on :8888`. If the service is already loaded it says so and exits;
if the plist is missing it tells you to run `scripts/install.sh` first.

## Stop

```bash
bash scripts/stop.sh
```

Prints `OK echo stopped`. If port 8888 is still in use afterwards, the script warns and
deliberately does **not** kill the owner — it may belong to another service. Never
broad-kill whatever owns port 8888.

## Restart — two idioms

```bash
bash scripts/restart.sh                        # stop + start, ends with a health check
launchctl kickstart -k "gui/$UID/com.echo"     # one-shot in-place restart
```

Both work. `restart.sh` unloads and reloads the LaunchAgent and verifies health;
`kickstart -k` is the quick one-liner after editing `core/server.ts` or a config file —
follow it with the health check below if you want confirmation.

## Status

```bash
bash scripts/status.sh
```

Shows the `launchctl` entry for `com.echo`, warns about still-loaded legacy services,
runs a health check, and prints the log path with the last five log lines.

## Health

```bash
curl -fsS http://localhost:8888/health
```

Returns JSON containing `"status":"healthy"`.

## Logs

- Server log: `~/Library/Logs/echo.log` — `tail -f` it while debugging.
- Voice-resolution log: `~/Library/Logs/echo/voice-resolution.jsonl` — records how each
  notification's requested voice resolved, including fallbacks. Details in
  [`providers-observability.md`](providers-observability.md).

## Update after a `git pull`

Bun runs the TypeScript sources directly — there is no build step.

- For code-only changes (`core/`, adapters), restart the daemon (either idiom above).
- When the pull touched install or registration behavior (`scripts/`, adapter
  registration), or when unsure, rerun the installer with your usual adapter. It is
  idempotent and also re-reconciles every other installed adapter:

```bash
bash scripts/install.sh --adapter <none|claudecode|pi|omp>
```

## Config changes need a restart

The daemon loads `core/voices.json` and `core/pronunciations.json` once at startup. After
editing either, restart — the `kickstart` idiom is the usual choice.

## Moved or renamed the repo?

The LaunchAgent plist and the adapter registrations point at the repo's on-disk location,
so a move or rename strands them. Rerun the installer once with any `--adapter` value —
it rewrites the plist and re-reconciles every installed adapter registration.

To audit without changing anything:

```bash
bash scripts/install.sh --check
```

Exit 0 when everything is current; exit 3 with `Stale paths found` on stderr when
anything is stale. Two caveats: `--check` verifies the plist's server path and working
directory but not the embedded `bun` binary path (after relocating a Bun install, rerun
the installer), and per-adapter exit codes fold into the aggregate 0/3 result — the full
per-adapter exit-code contract lives in [`adapters.md`](adapters.md).

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes the LaunchAgent and preserves logs. Adapter registrations are **not** removed:
Claude Code hook entries in `~/.claude/settings.json`, the Pi `packages` entry in
`~/.pi/agent/settings.json`, and the omp `echo-voice` symlink in
`~/.omp/agent/extensions/` all survive. There is no deregistration tool; remove those
entries by hand before deleting the repo directory, or hosts will keep pointing at dead
paths.

## Legacy services

The installer migrates the old `com.pai.voice-server` and `com.atlas.voicesystem`
LaunchAgents onto `com.echo` (it unloads them and quarantines their plists). Do not
reload them; if `status.sh` warns that one is still loaded, rerun the installer.
