# echo — oh-my-pi (omp) adapter

Dedicated omp host adapter (the first slice of [#109](https://github.com/edheltzel/Echo/issues/109),
splitting omp off the shared Pi adapter). It listens to omp lifecycle events and
translates them into `/notify` requests against the local voice server, tagged
`source: "omp"`.

It uses omp's own SDK (`@oh-my-pi/pi-coding-agent`) and imports only host-neutral
helpers from `shared/` (`notify-client`, `voice-line`, `echo-env`). It never imports
`core/` or the Pi adapter.

## Configuration

omp loads the same canonical `ECHO_VOICE_*` env vars as the Pi adapter (legacy
`ATLAS_VOICE_*` / `VOICESYSTEM_*` kept as silent deprecated fallbacks), via Echo's
environment-file chain. Durable local settings: `~/.config/echo/.env`. Defaults:
persona `omp`, voice `pi`.

## Per-project persona & voice

A repo can override the persona **name + voice** (and greeting) for that project
only, using the **same convention as the Claude Code and Pi adapters**: a `daidentity`
block in omp's native config. omp's config is YAML, layered project-over-user, so
Echo reads the `daidentity` block from `<project>/.omp/config.yml` (project) and
`~/.omp/agent/config.yml` (global) and merges project-over-global:

```yaml
# <project>/.omp/config.yml
daidentity:
  name: Echo
  voices:
    main:
      voiceId: en-GB-LibbyNeural
  startupCatchphrases:
    - Echo online.
```

Resolved at `session_start` from `ctx.cwd`, per key: project → global → env config.
`voiceId` is a real edge-tts voice name (`bun scripts/preview-voices.ts --list`) — the
daemon speaks it literally, no `core/voices.json` edit needed. Takes effect on the next
omp session started in that repo. With a persona **name** set, the startup greeting
**announces that name** (e.g. "Echo online and standing by.") unless the repo provides
its own `startupCatchphrases`.

### Scaffold it without hand-editing YAML

Inside omp, run:

```text
/echo-voice [name] [voice]
```

The cross-host analog of the Claude Code `/echo-voice` command. Both arguments are
optional — anything missing is prompted for. It validates that the voice is a real
edge-tts name, then merges the `daidentity` block into `<project>/.omp/config.yml` via
`Bun.YAML` (parse → set → stringify), preserving every other key. A present-but-unparseable
`config.yml` **aborts** rather than clobbering it. The command ships with the adapter (no
installer step). Takes effect on the next omp session in that repo.

## Status command

Inside omp:

```text
/voice-status
```

## Registration

`bash scripts/install.sh --adapter omp` runs `adapters/omp/reconcile.ts`, which maintains
a single `echo-voice` symlink in `~/.omp/agent/extensions/` pointing at this adapter
(idempotent, `--check`-aware, per the #77 reconcile-and-prune contract). It **migrates** an
existing Echo `echo-voice` link off the pre-split shared `adapters/pi/` onto `adapters/omp/`.

## Scope

The lifecycle, native-config persona override, and registration are in place. The remaining
#109 work is optional consolidation — folding the small config helpers (currently mirrored
between `adapters/pi` and `adapters/omp`) into `shared/`.
