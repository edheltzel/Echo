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

Adapters should expose endpoint configuration. For Pi (same for oh-my-pi, with `omp`), set:

```bash
ECHO_NOTIFY_URL=http://localhost:8889/notify pi
```

## Hot Reload

```bash
PORT=8889 bun --watch run core/server.ts
```

If a provider subprocess hangs, stop the watch process and clear the dev port.

## Auditioning edge voices

Choose per-agent edge-tts voices by ear with `bun scripts/preview-voices.ts` before editing `core/voices.json`. Commands, flags, and the workflow live in [voices.md](voices.md). The script calls `edge-tts` directly and is not on the runtime request path.

## Worktrees

Use local worktrees for isolated feature or release work when you do not want to disturb the
main `dev` checkout:

```bash
mkdir -p .worktrees
git worktree add -b fix/example .worktrees/fix-example origin/dev
```

`.worktrees/` is intentionally gitignored. Remove finished worktrees with
`git worktree remove .worktrees/<name>` and then `git worktree prune`.

## Tests

```bash
bun test
PORT=8889 tests/smoke-core.sh
```

CI runs the same trio (plus the Pi adapter build) headlessly on every PR into `dev`/`master`
and every push to those branches — see `.github/workflows/verify.yml`.

## Teardown

```bash
lsof -nP -iTCP:8889 | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
```

## Troubleshooting

- If `:8889` is busy, choose another dev port.
- If `edge-tts` fails, `/notify` should try real synthesis before falling back unless the Edge circuit is already open; inspect `attempts[]` in the resolution log for `phase`, `reason`, and stderr.
- If production voice changes, confirm you did not run scripts against `:8888` unintentionally.
