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
omp session started in that repo.

## Status command

Inside omp:

```text
/voice-status
```

## Scope (persona-first slice)

This slice delivers the omp lifecycle + native-config persona override. Still tracked
on #109: a dedicated `adapters/omp/reconcile.ts` (idempotent registration per the #77
contract), migrating the `~/.omp/agent/extensions/echo-voice` symlink from
`adapters/pi` to `adapters/omp`, and the `scripts/install.sh --adapter omp` rewiring.
