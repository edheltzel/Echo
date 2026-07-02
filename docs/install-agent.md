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

## 7. Heal after a repo move/rename

Every install run re-reconciles **all** installed adapter registrations regardless of `--adapter`, so after moving or renaming the repo directory one rerun of any install command removes every stale path. To audit without mutating:

```bash
bash scripts/install.sh --check
```

Expected: reports stale plist/hook/package paths if any; exit 0; nothing modified.

## 8. Status

```bash
bash scripts/status.sh
```

Expected: neutral service `com.echo` is listed or health returns OK.

## 9. Uninstall

```bash
bash scripts/uninstall.sh
```

Expected: LaunchAgent is removed. Logs are preserved.
