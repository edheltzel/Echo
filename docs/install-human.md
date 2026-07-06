# Human Install Guide

This guide installs `echo`, a local voice notification server for coding agents and scripts.

## What gets installed

The installer writes a macOS LaunchAgent for the universal core server and optionally registers one host adapter:

- **Core only** — any process can POST to `/notify`.
- **Claude Code adapter** — Claude Code lifecycle hooks speak.
- **Pi adapter** — Pi session start and `🗣️` completion lines speak.
- **oh-my-pi (omp) adapter** — the same Pi adapter registered with the oh-my-pi fork; same behavior and voice.

## Prerequisites

- macOS — the installer writes a LaunchAgent (Linux is best-effort for manual server runs only; see `docs/dependencies.md`).
- [Bun](https://bun.sh/).

Optional voice providers and host adapters are described in `docs/dependencies.md`.

## Install core only

```bash
bash scripts/install.sh --adapter none
```

This writes a neutral LaunchAgent (`com.echo`) and starts the server on `localhost:8888`.

You should see:

```
OK echo is healthy on :8888
```

If the installer prints `Voice server did not respond` instead, open the log at `~/Library/Logs/echo.log`.

## Add the Claude Code adapter

```bash
bash scripts/install.sh --adapter claudecode
```

This installs the same core server and re-applies Claude Code hook registrations through `adapters/claudecode/restore-hooks.ts`.

## Add the Pi adapter

```bash
bash scripts/install.sh --adapter pi
```

This installs the core server, then registers `adapters/pi/` as a Pi package and reconciles the registration so no stale entry survives.

Inside Pi, `/voice-status` shows adapter configuration.

## Add the oh-my-pi (omp) adapter

```bash
bash scripts/install.sh --adapter omp
```

This installs the core server and registers the shared Pi adapter with oh-my-pi by maintaining a single `echo-voice` symlink in `~/.omp/agent/extensions/`. It requires the `omp` CLI on your PATH. omp uses the same voice and persona as Pi.

The installer only ever touches the `echo-voice` entry. If something other than Echo already occupies that name, the install aborts before changing anything — see `docs/adapters.md` for the ownership rules.

## Moved or renamed the repo directory?

Rerun the installer once (any `--adapter` value). It rewrites the LaunchAgent and re-reconciles every installed adapter registration, removing paths that point at the old location. To see what's stale without changing anything:

```bash
bash scripts/install.sh --check
```

## Verify manually

```bash
curl -fsS http://localhost:8888/health
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"Hello from echo"}'
```

The first command returns JSON containing `"status":"healthy"`. The second returns `"status":"success"` and speaks aloud.

### If you hear nothing, or the wrong voice

- Check the service: `bash scripts/status.sh` shows load state, health, and the last log lines.
- Tail the server log: `tail -20 ~/Library/Logs/echo.log`.
- Read the voice-resolution log at `~/Library/Logs/echo/voice-resolution.jsonl` — it records how each notification's requested voice resolved, including fallbacks. An unexpected voice usually means the provider chain fell back (for example to macOS `say`). `docs/voices.md` explains voice resolution; `docs/dependencies.md` lists what each provider needs.

Day-to-day start/stop/restart/status procedures live in `docs/operations.md`.

## Choose voices (audition)

Pick voices by ear with `bun scripts/preview-voices.ts` before editing `core/voices.json`. Commands, the full flag table, and how to apply your choice live in `docs/voices.md`.

## Uninstall

```bash
bash scripts/uninstall.sh
```

The uninstall script removes the neutral LaunchAgent but preserves logs and repo files.

It does **not** remove adapter registrations: Claude Code hook entries in `~/.claude/settings.json`, the Pi `packages` entry in `~/.pi/agent/settings.json`, and the omp `echo-voice` symlink in `~/.omp/agent/extensions/` all survive uninstall. There is no deregistration tool; if you are deleting the repo directory, remove those entries by hand first so hosts don't keep calling paths that no longer exist.

## Operations

Start, stop, restart, status, logs, updating after a `git pull`, and repo-move recovery are covered in `docs/operations.md`.

## Development

For local development without disturbing the production service, use `docs/development.md`.
