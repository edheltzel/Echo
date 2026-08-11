# Development Workflow

## Prerequisites

- Bun installed.
- Git checkout on `dev`.
- Optional providers documented in `docs/dependencies.md`.

## Clone & Install

Bun runs TypeScript directly - there is no build step and no third-party dependency to
fetch. One command is still required:

```bash
bun install
```

This is offline: every workspace member (`shared`, `adapters/*`) is local, so `bun install`
only links them. It creates `adapters/<host>/node_modules/@echo/shared`, which is how each
adapter resolves the shared package it declares instead of reaching up the tree. **Skip it
and a registered adapter fails to load.** `scripts/install.sh` runs it for you, and
`scripts/install.sh --check` reports a missing link as stale.

## Run Dev Server

Use a non-production port so the installed LaunchAgent on `:3246` is not disturbed. Redirect
the config reader with the test/development-only `ECHO_CONFIG_FILE` path selector:

```bash
mkdir -p .scratch
printf '%s\n' '{"PORT":8889,"ECHO_DAEMON_URL":"http://localhost:8889"}' > .scratch/echo-dev-config.json
ECHO_CONFIG_FILE="$PWD/.scratch/echo-dev-config.json" bun run core/server.ts
```

## Pointing Clients at Dev

Silent smoke request:

```bash
curl -fsS -X POST http://localhost:8889/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"dev smoke","voice_enabled":false}'
```

Point Pi (or omp) at the same isolated config:

```bash
ECHO_CONFIG_FILE="$PWD/.scratch/echo-dev-config.json" pi
```

## Hot Reload

```bash
ECHO_CONFIG_FILE="$PWD/.scratch/echo-dev-config.json" bun --watch run core/server.ts
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
bun install                  # required before bun test - adapters import @echo/shared
bun test
PORT=8889 tests/smoke-core.sh  # isolated test-harness injection, not user configuration
tests/e2e-adapters.sh        # adapter boundary e2e against an isolated daemon
tests/e2e-converse.sh        # one voice-ask turn against an isolated core + coordinator
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/echo-pi-build
bun build adapters/omp/index.ts --target=bun --external @oh-my-pi/pi-coding-agent --outdir /tmp/echo-omp-build
bun build adapters/mcp/server.ts --target=bun --outdir /tmp/echo-mcp-build
bun build adapters/jcode/hook.ts --target=bun --outdir /tmp/echo-jcode-build
bun build adapters/grok/hook.ts --target=bun --outdir /tmp/echo-grok-build
```

CI runs exactly that set headlessly on every PR into `dev`/`master` and every push to those
branches - see `.github/workflows/verify.yml`.

### Never test against the running daemon

The installed LaunchAgent on `:3246` serves the operator's real notifications. Stopping it,
retargeting it, overwriting its config, or speaking through it is a live-system incident, not
a test.

`tests/e2e-adapters.sh` is the safe path. It starts its own `core/server.ts` on its own port
(`ECHO_E2E_PORT`, default `8899`) with every state path - mute, capture guard, audio cache,
TTS cache, lifecycle log, and `VOICES_PATH` - redirected through a scratch config file,
while exported copies exist only for inline test assertions. It kills only the pid it started. It **refuses to run**
if the chosen port is `3246` or if anything is already listening there: it never attaches to a
daemon it does not own. Before sending anything it prints an isolation proof (pid, port,
adapter target, scratch dir).

```bash
tests/e2e-adapters.sh              # silent - safe anywhere
tests/e2e-adapters.sh --audible    # also speaks, on the isolated instance only
```

`tests/e2e-converse.sh` applies the same discipline to the voice ask, with two additions of its
own. It starts a second isolated process (the `echo-converse` coordinator, `ECHO_E2E_CONVERSE_PORT`,
default `8922`) and refuses `32468` as well as `3246`. And its recorder and transcriber are
stand-in scripts, so it opens no microphone and needs neither `sox` nor `yap` - which is what lets
it run on CI. Silence comes from disabling every provider in its own scratch `voices.json`: an ask
forces `voice_enabled` on by design, so `--audible` is the only way to hear it (and the only way
to exercise real synthesis timing in the drain wait). See [converse.md](converse.md).

Every spoken test line begins `Echo Test engaged. Beep, boop, bop.` so anything audible is
unmistakably a test and never mistaken for a real notification.

## Teardown

```bash
lsof -nP -iTCP:8889 | awk 'NR>1 {print $2}' | xargs kill 2>/dev/null || true
```

## Troubleshooting

- If `:8889` is busy, choose another dev port.
- If `edge-tts` fails, `/notify` should try real synthesis before falling back unless the Edge circuit is already open; inspect `attempts[]` in the resolution log for `phase`, `reason`, and stderr.
- If production voice changes, confirm you did not run scripts against `:3246` unintentionally.
