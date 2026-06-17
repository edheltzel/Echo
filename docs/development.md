# Development Workflow

## Prerequisites

- Bun installed.
- Git checkout on `dev`.
- Optional providers documented in `docs/dependencies.md`.

## Clone & Install

This repo has no npm install step for normal development. Bun runs TypeScript directly.

## Run Dev Server

Use a non-production port so the installed LaunchAgent on `:8888` is not disturbed:

```bash
PORT=8889 bun run core/server.ts
```

## Pointing Clients at Dev

Silent smoke request:

```bash
curl -fsS -X POST http://localhost:8889/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"dev smoke","voice_enabled":false}'
```

Adapters should expose endpoint configuration. For Pi, set:

```bash
ATLAS_VOICE_NOTIFY_URL=http://localhost:8889/notify pi
```

## Hot Reload

```bash
PORT=8889 bun --watch run core/server.ts
```

If a provider subprocess hangs, stop the watch process and clear the dev port.

## Auditioning edge voices

Per-agent edge-tts voices live in `core/voices.json` (each agent's `edgetts: { voice, speed }`). To choose voices by ear before editing that file, sample them with:

```bash
bun scripts/preview-voices.ts --list            # list English voices, no audio
bun scripts/preview-voices.ts --locale en-GB    # play every en-GB voice
bun scripts/preview-voices.ts --voices en-GB-ThomasNeural --rate -6%
```

`--list`/`--dry-run` are audio-free (CI-safe). See the **Voices** section of `README.md` for the full flag table. The script calls `edge-tts` directly and is not on the runtime request path.

## Tests

```bash
bun test
PORT=8889 tests/smoke-core.sh
```

## Teardown

```bash
lsof -nP -iTCP:8889 | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
```

## Troubleshooting

- If `:8889` is busy, choose another dev port.
- If `edge-tts` fails, health should fall back through the provider chain.
- If production voice changes, confirm you did not run scripts against `:8888` unintentionally.
