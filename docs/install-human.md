# How to install Echo

This is the how-to for wiring Claude Code, Pi, oh-my-pi, and the other hosts after Echo
already speaks. If you have not heard "Hello from Echo" yet, start with
[Hear your first spoken notification](getting-started.md). Read [What Echo does](what-echo-does.md)
for when it speaks and how mute works in a shared office.

## What gets installed

The installer writes a macOS LaunchAgent for the universal core server and optionally registers one host adapter:

- **Core only** - any process can POST to `/notify`.
- **Claude Code adapter** - lifecycle hooks speak, with `/echo-voice` and `/echo-mute`
  slash commands. A mute-only plugin at `adapters/claudecode/plugin/` is optional
  (`/echo:echo-mute`; bare `/echo-mute` stays the installer command) and does not
  replace this install.
- **Jcode adapter** - explicit `🗣️` completion lines speak through Jcode lifecycle hooks.
- **Pi adapter** - Pi session start and `🗣️` completion lines speak.
- **oh-my-pi (omp) adapter** - the omp counterpart of the Pi adapter; same behavior, its own package.
- **Grok Build adapter** - Grok Build lifecycle hooks speak turn completions; `/echo-mute` is a skill.
- **Codex adapter** - Codex lifecycle hooks speak turn completions and opt-in session starts; `/echo-mute` is a skill.
- **MCP adapter** - gives Claude Code the voice-ask tool (Pi and omp already have it).
- **OpenCode adapter** - mute-only `/echo-mute` command.

## Prerequisites

- macOS - the installer writes a LaunchAgent (Linux is best-effort for manual server runs only; see `docs/dependencies.md`).
- [Bun](https://bun.sh/).

Voice notifications need nothing else. The optional one-shot voice ask has a hard recorder
dependency, `sox`, and needs one local transcriber. For the recommended macOS 26 path:

```bash
brew install sox  # provides the required `rec` command
brew install yap  # on-device transcription
```

A local `whisper-cli` plus a model can replace `yap`, but not `sox`. Optional voice providers,
host adapters, and the Whisper setup are described in `docs/dependencies.md`.

## Install core only

```bash
cli/echo install --adapter none          # or: bash scripts/install.sh --adapter none
```

`cli/echo` is the stable human surface and delegates to `scripts/install.sh`; either form
works. This writes a neutral LaunchAgent (`com.echo`) and starts the server on
`localhost:3246`.

You should see:

```
OK echo is healthy on :3246
```

If the installer prints `Voice server did not respond` instead, open the log at `~/Library/Logs/echo.log`.

If it refuses with `Port 3246 is occupied but not answering Echo's /health`, something is holding the port without serving Echo - either a wedged Echo daemon (`bash scripts/restart.sh`) or an unrelated process (stop it and rerun). Echo never kills the port owner. `cli/echo doctor` reports the same state with a recovery command per row.

## Add the Claude Code adapter

```bash
cli/echo install --adapter claudecode    # or: bash scripts/install.sh --adapter claudecode
```

This installs the same core server, re-applies Claude Code hook registrations through
`adapters/claudecode/restore-hooks.ts`, and reconciles the `echo-voice.md` and `echo-mute.md`
symlinks in `~/.claude/commands/` through `adapters/claudecode/reconcile-commands.ts`.
The reconciler preserves a non-Echo file or symlink occupying either command name and aborts
the install instead of overwriting it.

A mute-only Claude Code plugin also lives at `adapters/claudecode/plugin/`. It is not a
substitute for this install: hooks stay on `restore-hooks.ts`, and the plugin does not
write a LaunchAgent. Load it with `claude --plugin-dir adapters/claudecode/plugin` after
`claude plugin validate adapters/claudecode/plugin --strict`. Claude namespaces plugin
skills, so the plugin command is `/echo:echo-mute`. Bare `/echo-mute` stays the
installer command from this step. Both run `cli/echo mute`.

## Add the Pi adapter

```bash
cli/echo install --adapter pi
```

The equivalent underlying command is:

```bash
bash scripts/install.sh --adapter pi
```

This installs the core server, then registers `adapters/pi/` as a Pi package and reconciles the registration so no stale entry survives.

Inside Pi, `/voice-status` shows adapter configuration. `/echo-mute` toggles the same machine-wide mute as `cli/echo mute`.

To prove the install without launching Pi's TUI: `bash scripts/prove-pi.sh`. Checklist: [`../adapters/pi/README.md`](../adapters/pi/README.md#prove-pi).

## Add the oh-my-pi (omp) adapter

```bash
cli/echo install --adapter omp
```

The equivalent underlying command is:

```bash
bash scripts/install.sh --adapter omp
```

This installs the core server and registers `adapters/omp/` with oh-my-pi by maintaining a single `echo-voice` symlink in `~/.omp/agent/extensions/`. It requires the `omp` CLI on your PATH. Per-project persona and voice overrides read omp's own `.omp/config.yml` - see [`../adapters/omp/README.md`](../adapters/omp/README.md).

The installer only ever touches the `echo-voice` entry. If something other than Echo already occupies that name, the install aborts before changing anything - see `docs/adapters.md` for the ownership rules.

## Add the Grok Build adapter

```bash
cli/echo install --adapter grok
```

The equivalent underlying command is:

```bash
bash scripts/install.sh --adapter grok
```

This installs the core server and registers one Echo-owned file at
`~/.grok/hooks/echo-voice.json` (global hooks are always trusted). It requires the `grok`
CLI on your PATH. Sibling hook files in that directory are never modified.

## Add the Codex adapter

```bash
cli/echo install --adapter codex
```

The equivalent underlying command is:

```bash
bash scripts/install.sh --adapter codex
```

This installs the core server and reconciles Echo-owned `SessionStart` and `Stop` hooks in the
project's `.codex/hooks.json` when it exists, or in `~/.codex/hooks.json` otherwise. It requires
the `codex` CLI on your PATH.

## Add the voice-ask tool (Claude Code)

```bash
cli/echo install --adapter mcp
```

The equivalent underlying command is:

```bash
bash scripts/install.sh --adapter mcp
```

This registers the `echo-converse` MCP server in `~/.claude.json`, which gives Claude Code the
`echo_ask` tool: Echo speaks a question and returns what you say back. Pi and omp get the same
tool from their existing adapters, so they need no extra install step.

Echo owns only the `echo-converse` server name; if something else already holds it, the install
aborts before changing anything. The adapter install checks `sox` and `rec` before changing host
state, but a missing recorder produces a warning rather than blocking the notification install.
Treat voice ask as not installed until `brew install sox` has supplied both commands and the check
passes; a missing `rec` is refused before capture begins. `cli/echo doctor` repeats the check later.

The first ask needs macOS microphone permission, and on the measured Pi/omp path the prompt names
your terminal application rather than Echo; Claude Code's stdio MCP ancestry is still unverified.
[`converse.md`](converse.md#before-you-enable-it) is the single source for the permission and
attribution conditions, Echo's lack of a per-question prompt, the recording lifecycle and cleanup
guarantee, and provider egress.

## Moved or renamed the repo directory?

The daemon is unaffected - it runs from a staged copy under `~/Library/Application Support/echo/payload`, not from the checkout. Only adapter registrations still point at the repo, so rerun the installer once (any `--adapter` value) to re-reconcile them. To see what's stale without changing anything:

```bash
bash scripts/install.sh --check      # or: cli/echo doctor
```

Full detail, including what `--check` does and does not verify: `docs/operations.md`.

## Verify the install

```bash
cli/echo doctor
```

This is the canonical "did my install work" check. It prints one row per check and ends with:

```
Result: READY
```

Any failing row prints its own recovery command underneath, and the run ends with
`Result: DEGRADED` and a non-zero exit. The `payload` row reports the staged daemon version; see
[Doctor](operations.md#doctor) for the detailed check contract and current-release example.

To hear a line, use the audible smoke in
[Hear your first spoken notification](getting-started.md).
A silent HTTP check is:

```bash
curl -fsS http://localhost:3246/health
```

Day-to-day start, stop, restart, and status live in [operations.md](operations.md).

## Choose voices (audition)

Pick voices by ear with `bun scripts/preview-voices.ts` before editing `core/voices.json`. Commands, the full flag table, and how to apply your choice live in `docs/voices.md`.

## Silence Echo temporarily

```bash
cli/echo mute on         # also: off | toggle | status
cli/echo mute 30m        # timed; `1h` works too. Voice resumes by itself.
```

Audio off, notifications still accepted. Mute is machine-wide and only covers audio Echo
produced. See [Silence and mute](what-echo-does.md#silence-and-mute) for layers and what
still makes sound. Commands and the state file are in [operations.md](operations.md#mute).

## Give a project its own persona

Inside the repo, in your host (Claude Code, Pi, or omp):

```text
/echo-voice [name] [voice]
```

This auditions edge-tts voices and merge-writes a `daidentity` block into that project's own
config, preserving every other setting; it takes effect on the next session there. For a global
Pi/omp default rather than one repo's, use `cli/echo voice <name> <edge-tts-voice-id>`. Claude Code
ignores those persona values; configure its global persona and voice in
`~/.claude/settings.json`. Both paths are covered in
[`voices.md`](voices.md#per-project-persona--voice-local-override).

## Uninstall

```bash
bash scripts/uninstall.sh          # or: cli/echo uninstall  (--check previews it)
```

This removes the neutral LaunchAgent and the staged daemon payload, preserving logs, your persona config, and repo files.

It does **not** remove adapter registrations - they survive uninstall, and there is no deregistration tool, so remove them by hand before deleting the repo directory. Which entries, and where: `docs/operations.md`.

## Operations

After a `git pull`, run `cli/echo update` to re-stage the daemon payload from the checkout;
restarting alone keeps the old payload running. Start, stop, restart, status, logs, mute, and
repo-move recovery are covered in `docs/operations.md`.

## Development

For local development without disturbing the production service, use `docs/development.md`.
