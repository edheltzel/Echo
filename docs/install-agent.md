# Agent Install Checklist

Follow one step at a time. Each step includes an assertion.

## 1. Confirm prerequisites

```bash
command -v bun
```

Expected: prints a path and exits 0.

If FAIL: install Bun from <https://bun.sh/>.

## 2. Install core only

```bash
bash scripts/install.sh --adapter none
```

Expected: exits 0 and prints `OK echo is healthy on :8888`.

If FAIL: inspect `~/Library/Logs/echo.log`.

## 3. Verify health

```bash
curl -fsS http://localhost:8888/health
```

Expected: JSON with `"status":"healthy"`.

If FAIL: run `bash scripts/status.sh`.

## 4. Verify silent notification

```bash
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"install verification","voice_enabled":false}'
```

Expected: JSON with `"status":"accepted"` (HTTP 202 — the line is queued and speaks async).

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

Expected: the reconcile reports the `echo-voice` symlink in `~/.omp/agent/extensions/` (created, re-pointed, or already current) and the health check passes. omp reuses the shared Pi adapter and the Pi voice — there is no separate `adapters/omp/`.

If FAIL: confirm `command -v omp` works. A `FATAL` message (exit 2) means something other than Echo occupies the `echo-voice` name; the installer refuses to replace it and aborts before mutating any host state. Inspect the entry manually — ownership rules in `docs/adapters.md`.

## 8. Heal after a repo move/rename

Every install run re-reconciles **all** installed adapter registrations regardless of `--adapter`, so after moving or renaming the repo directory one rerun of any install command removes every stale path. To audit without mutating:

```bash
bash scripts/install.sh --check
```

Expected: nothing modified. Exit 0 when everything is current; exit 3 (with a "Stale paths found" summary on stderr) when any stale path was detected — machine-checkable for automation.

## 9. Status

```bash
bash scripts/status.sh
```

Expected: neutral service `com.echo` is listed or health returns OK.

## 10. Uninstall

```bash
bash scripts/uninstall.sh
```

Expected: LaunchAgent is removed. Logs are preserved.

Caveat: adapter registrations are **not** removed — Claude Code hook entries in `~/.claude/settings.json`, the Pi `packages` entry in `~/.pi/agent/settings.json`, and the omp `echo-voice` symlink in `~/.omp/agent/extensions/` all survive uninstall. No deregistration tooling exists; remove those entries manually before deleting the repo directory.
