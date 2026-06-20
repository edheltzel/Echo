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

Expected: exits 0 and prints `OK atlas-voicesystem is healthy on :8888`.

If FAIL: inspect `~/Library/Logs/atlas-voicesystem.log`.

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

## 5. Install PAI adapter when needed

```bash
bash scripts/install.sh --adapter pai
```

Expected: restore-hooks output reports existing or added PAI hook registrations.

This wires the repo-owned per-turn voice **Stop** hook (`adapters/pai/hooks/VoiceCompletion.hook.ts`) into `settings.json`. Registration is idempotent: re-running the installer replaces any prior VoiceCompletion Stop entry in place (no duplicates), so an uninstall→reinstall cycle always converges to exactly one Stop entry.

If FAIL: confirm PAI/Claude settings file exists and is writable.

## 6. Install Pi adapter when needed

```bash
bash scripts/install.sh --adapter pi
```

Expected: Pi package install succeeds and health check passes.

If FAIL: confirm `command -v pi` works, then run `pi install ./adapters/pi` manually.

## 7. Status

```bash
bash scripts/status.sh
```

Expected: neutral service `com.atlas.voicesystem` is listed or health returns OK.

## 8. Uninstall

```bash
bash scripts/uninstall.sh
```

Expected: LaunchAgent is removed. Logs are preserved.
