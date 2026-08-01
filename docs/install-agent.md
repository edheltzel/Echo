# Agent Install Checklist

Follow one step at a time. Each step includes an assertion.

## 1. Confirm prerequisites

```bash
command -v bun
```

Expected: prints a path and exits 0.

If FAIL: install Bun from <https://bun.sh/>.

When the requested setup includes one-shot voice ask, install and assert the capture path too:

```bash
brew install sox
brew install yap
bash scripts/converse-dependencies.sh
command -v yap
```

Expected: the dependency script prints resolved paths for both `sox` and `rec`. Then
`command -v yap` prints the recommended on-device transcriber. A configured `whisper-cli` plus a
readable `ECHO_CONVERSE_WHISPER_MODEL` property in config.json may replace `yap`, but `sox` remains required. Do not report voice
ask ready merely because the adapter installer succeeded: it warns and continues when capture
tools are absent so notification-only installs still work.

## 2. Install core only

```bash
bash scripts/install.sh --adapter none
```

Expected: exits 0 and prints `OK echo is healthy on :3246`.

If FAIL: run `cli/echo doctor` - it names the degraded state and a recovery command per row - then inspect `~/Library/Logs/echo.log`. An install that refuses because port 3246 is occupied but not serving Echo wrote nothing to that log.

## 3. Verify health

```bash
curl -fsS http://localhost:3246/health
```

Expected: JSON with `"status":"healthy"`.

If FAIL: run `bash scripts/status.sh`.

## 4. Verify silent notification

```bash
curl -fsS -X POST http://localhost:3246/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"install verification","voice_enabled":false}'
```

Expected: JSON with `"status":"success"`.

If FAIL: check rate limit and server logs.

## 5. Install Claude Code adapter when needed

```bash
bash scripts/install.sh --adapter claudecode
```

Expected: restore-hooks output reports existing or added Claude Code hook registrations.

This wires the repo-owned per-turn voice **Stop** hook (`adapters/claudecode/hooks/VoiceCompletion.hook.ts`) into `settings.json`. Registration is idempotent: re-running the installer replaces any prior VoiceCompletion Stop entry in place (no duplicates), so an uninstall→reinstall cycle always converges to exactly one Stop entry.

If FAIL: confirm the Claude Code settings file exists and is writable.

## 6. Install Pi adapter when needed

```bash
bash scripts/install.sh --adapter pi
```

Expected: Pi package install succeeds, the registration reconcile reports the canonical `adapters/pi` entry, and health check passes.

If FAIL: confirm `command -v pi` works, then run `pi install ./adapters/pi` and `bun run adapters/pi/reconcile.ts` manually.

## 7. Install oh-my-pi (omp) adapter when needed

```bash
bash scripts/install.sh --adapter omp
```

Expected: the reconcile reports the `echo-voice` symlink in `~/.omp/agent/extensions/` (created, re-pointed, or already current) and the health check passes. omp has its own package at `adapters/omp/`, but shares the Pi persona and voice defaults.

If FAIL: confirm `command -v omp` works. A `FATAL` message (exit 2) means something other than Echo occupies the `echo-voice` name; the installer refuses to replace it and aborts before mutating any host state. Inspect the entry manually - ownership rules in `docs/adapters.md`.

## 8. Install the Jcode lifecycle hook adapter when needed

```bash
bash scripts/install.sh --adapter jcode
```

Expected: the reconcile reports Jcode `session_start` and `turn_end` hooks in `~/.jcode/config.toml` and the health check passes. If FAIL: confirm `command -v jcode` works and inspect the existing hook owner; the installer refuses to replace a non-Echo hook.

## 9. Install the voice-ask MCP server when needed

```bash
bash scripts/install.sh --adapter mcp
```

Expected: the dependency check resolves `sox` and `rec`, the reconcile reports the
`echo-converse` entry in `~/.claude.json` (created, re-pointed, or already current), and the core
health check passes. `ECHO_MCP_CONFIG_PATH` overrides the target.

If the installer prints a capture-tools warning but otherwise exits 0, the MCP registration and
notification daemon were installed, but voice ask is not ready. Run `brew install sox`, rerun
`scripts/converse-dependencies.sh`, and verify one local transcriber before reporting success.

If FAIL: exit 2 means a foreign server already holds the `echo-converse` name; Echo will not
overwrite it, and aborts before mutating any host state. Pi and omp expose the same `echo_ask` tool
from their existing adapters, so they need no extra registration step. See
[`converse.md`](converse.md).

## 10. Heal after a repo move/rename

Every install run re-reconciles **all** installed adapter registrations regardless of `--adapter`, so after moving or renaming the repo directory one rerun of any install command removes every stale path. To audit without mutating:

```bash
bash scripts/install.sh --check
```

Expected: nothing modified. Exit 0 when everything is current; exit 3 (with a "Stale paths found" summary on stderr) when any stale path was detected - machine-checkable for automation.

## 10. Status

```bash
bash scripts/status.sh
```

Expected: neutral service `com.echo` is listed or health returns OK.

## 11. Uninstall

```bash
bash scripts/uninstall.sh --check  # preview: prints what would be removed, mutates nothing
bash scripts/uninstall.sh
```

Expected: exits 0; the LaunchAgent and the staged daemon payload are removed. Logs and `~/.config/echo/config.json` are preserved.

Caveat: adapter registrations are **not** removed and no deregistration tooling exists; remove them manually before deleting the repo directory. The full list is in `docs/operations.md`.
