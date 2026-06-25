# MIGRATIONS

Tracks PAI-side edits that may be clobbered by upstream PAI updates. The atlas voice server itself now lives in this repo as a universal core plus adapters; PAI-specific runtime glue is under `adapters/pai/`.

## Current install/migration model

```bash
# Core only
bash scripts/install.sh --adapter none

# Core + PAI hook registration
bash scripts/install.sh --adapter pai

# Core + Pi adapter package
bash scripts/install.sh --adapter pi
```

Neutral service identity:

- LaunchAgent label: `com.atlas.voicesystem`
- Plist: `~/Library/LaunchAgents/com.atlas.voicesystem.plist`
- Log: `~/Library/Logs/atlas-voicesystem.log`

The installer unloads the old `com.pai.voice-server` service if loaded and quarantines `~/Library/LaunchAgents/com.pai.voice-server.plist` to prevent login-time port races.

## PAI hook registration

Canonical command:

```bash
bun run adapters/pai/restore-hooks.ts
```

Compatibility command:

```bash
bun run scripts/restore-hooks.ts
```

`adapters/pai/restore-hooks.ts`:

- Derives hook paths from its actual repo location (`import.meta.url`), so clones do not need to live under `~/Developer/atlas-voicesystem`.
- Treats historical hard-coded paths as duplicate-detection compatibility only.
- Adds the PAI `VoiceGate.hook.ts` to the existing `PreToolUse` matcher `Bash`.
- Adds the PAI `VoiceGreeting.hook.ts` to the `SessionStart` matcher `startup`.
- Backs up `~/.claude/settings.json` before writing.
- Enforces mode `0600`.
- Supports `--check` for installer preflight without mutation.

## After a PAI upgrade

1. **Disable PAI/Pulse built-in voice** if the upgrade re-enabled it:

   ```toml
   # ~/.claude/PAI/PULSE/PULSE.toml
   [voice]
   enabled = false
   ```

2. **Retarget PAI voice curls from Pulse `:31337` to atlas `:8888`**:

   ```bash
   find ~/.claude/PAI ~/.claude/hooks -type f \( -name "*.ts" -o -name "*.sh" \) -print0 \
     | xargs -0 sed -i '' \
       's|localhost:31337/notify|localhost:8888/notify|g; s|127\.0\.0\.1:31337/notify|127.0.0.1:8888/notify|g'
   ```

3. **Re-apply PAI hook registrations**:

   ```bash
   bun run ~/Developer/atlas-voicesystem/adapters/pai/restore-hooks.ts
   ```

4. **Ensure the neutral core service is installed and healthy**:

   ```bash
   bash ~/Developer/atlas-voicesystem/scripts/install.sh --adapter pai
   curl -fsS http://localhost:8888/health
   ```

5. **Verify the old PAI-named voice service is gone**:

   ```bash
   launchctl list | grep -E 'com\.atlas\.voicesystem|com\.pai\.voice-server' || true
   ls ~/Library/LaunchAgents/com.pai.voice-server.plist 2>/dev/null && echo "old plist still present"
   ```

Only `com.atlas.voicesystem` should remain loaded for atlas-voicesystem.

## `/pai` compatibility note

The universal core does **not** expose a PAI-named endpoint. PAI callers should use `POST /notify`. Unsupported POST paths return explicit JSON `404` rather than a false-success `200`.

## Historical affected PAI files

Older investigations found PAI voice references in these areas. The find/replace command above is the current safer reapply path, because exact upstream filenames may drift:

- `~/.claude/PAI/TOOLS/`
- `~/.claude/PAI/PULSE/`
- `~/.claude/PAI/PAI-Install/`
- `~/.claude/hooks/`
- voice examples embedded in PAI markdown docs

If a PAI upgrade changes where voice calls live, search for both `31337/notify` and `/pai` and migrate active callers to `8888/notify`.

## Verified re-apply log

| Date | What was re-applied | Notes |
|------|---------------------|-------|
| 2026-05-21 | PAI voice refs, settings hooks, chmod | Pre-adapter-layout migration. Historical context only; current reapply commands above supersede old hard-coded hook paths and old `com.pai.voice-server` service instructions. |
| 2026-06-01 | core/adapters layout | Universal core moved to `core/`; PAI hook glue moved to `adapters/pai/`; Pi adapter added under `adapters/pi/`; neutral service identity introduced. |
