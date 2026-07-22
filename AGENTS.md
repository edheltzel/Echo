# AGENTS.md

Lean entry point for agents working on `echo`. This file is the build/test
commands, the repo map, the hard invariants, and the DOX rail. Architecture and per-area
detail live behind the pointers below — load them on demand (progressive disclosure).

## Architecture in one breath

A host-neutral daemon (`core/server.ts`, listening on `localhost:8888`) speaks text POSTed to
`POST /notify`; hosts integrate **out-of-process** via adapters (`adapters/claudecode/`,
`adapters/pi/`) that never import `core/`. Full codemap,
boundaries, request/voice flow, and cross-cutting concerns: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Do **not** add host-specific logic to `core/`. Host lifecycle behavior belongs in an adapter
that calls `POST /notify`.

## Quick commands

```bash
# Link the workspace (adapters resolve @echo/shared through it)
bun install

# Install (core only / with a host adapter)
bash scripts/install.sh --adapter none
bash scripts/install.sh --adapter claudecode
bash scripts/install.sh --adapter pi
bash scripts/install.sh --adapter omp

# Lifecycle
bash scripts/{status,start,stop,restart,uninstall}.sh

# Runtime mute (audio off; notifications still processed + logged)
bash scripts/mute.sh on|off|toggle|status   # `on 30` = timed; empty POST /mute toggles

# Health / silent smoke
curl -fsS http://localhost:8888/health
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'
```

Service identity:

- LaunchAgent label: `com.echo`
- Plist: `~/Library/LaunchAgents/com.echo.plist`
- Log: `~/Library/Logs/echo.log`

The installer unloads and quarantines the legacy `com.pai.voice-server` and
`com.atlas.voicesystem` plists if found (a reinstall migrates a running legacy service onto
`com.echo`). Do not resurrect the old services.

## Development workflow

```bash
git checkout dev
bun install                 # links @echo/shared into each adapter package (required)
bun test
PORT=8889 tests/smoke-core.sh
tests/e2e-adapters.sh       # isolated daemon on :8899; --audible to hear it
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/echo-pi-build
```

**`bun install` is a prerequisite, not an optimization.** Adapters resolve `@echo/shared`
through their own `node_modules`; without the workspace links a registered adapter fails to
load. `scripts/install.sh` runs it, and `--check` reports a missing link as stale.

**Never test against the running daemon.** It serves the operator's real notifications, so
restarting it, retargeting it, or speaking through it is a live-system incident.
`tests/e2e-adapters.sh` starts its own instance on its own port with every state path
(mute, capture, audio cache, TTS cache, lifecycle log, `VOICES_PATH`) redirected to scratch,
refuses to attach to a port it does not own, and prints an isolation proof before sending
anything. Spoken test lines begin `Echo Test engaged. Beep, boop, bop.` so anything audible
is unmistakably a test.

After changing `core/server.ts`, restart: `launchctl kickstart -k "gui/$UID/com.echo"`
(tail `~/Library/Logs/echo.log`). Use **Bun only** — no npm/npx/node. Run
`bun test` + the smoke + the adapter e2e + the Pi build before shipping; CI machine-runs the
same set on every PR into `dev`/`master` (`.github/workflows/verify.yml`).

## Release & versioning

Project version lives in the root `package.json` (declarative metadata only — no code reads
it). Track notable changes in `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/)
+ [SemVer](https://semver.org/)). **Flow:** work on `dev` → PR into `dev` → reviewer sign-off
→ **Ed merges** → `dev`→`master` promotion PR → tag `vX.Y.Z` + GitHub release. **Ed owns all
merges; never push directly to `master`** (see Invariants).

**Promotion PRs must be merge-committed, never squashed.** Squashing a `dev`→`master`
promotion collapses the merge and drops `dev` from `master`'s ancestry, recreating the
divergence that makes the *next* promotion phantom-conflict (bit us on #74). If a promotion is
squashed anyway, immediately resync with a real merge commit: `git merge origin/master` into
`dev` (favor master's version/CHANGELOG) and push `dev`, restoring `master` as an ancestor.

## Documentation map

| Topic | Doc |
|---|---|
| Architecture codemap, boundaries, invariants | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Security model (trust boundary, egress, secrets) | [SECURITY.md](SECURITY.md) |
| HTTP API (`/notify`, `/notify/personality`, `/mute`, `/health`, `/voices`) + mute hotkey bindings | [docs/http-api.md](docs/http-api.md) |
| Provider egress gating + drop-off log (#24) | [docs/providers-observability.md](docs/providers-observability.md) |
| Circuit breaker + reliability env knobs | [docs/reliability.md](docs/reliability.md) |
| Voices, audition + per-turn persona voice (Stop hook) | [docs/voices.md](docs/voices.md) |
| Adapter rules + package boundary + registration contract (#77) + Pi #15 + oh-my-pi #18/#109 | [docs/adapters.md](docs/adapters.md) |
| Shipped design decisions | [docs/design-docs/index.md](docs/design-docs/index.md) |
| Implementation plans · session handoffs | [docs/plans/](docs/plans/) · [docs/handoffs/](docs/handoffs/) |
| Documentation ownership contract · DOX procedure | [docs/AGENTS.md](docs/AGENTS.md) · [docs/dox.md](docs/dox.md) |
| Getting started (first install → first spoken notification) | [docs/getting-started.md](docs/getting-started.md) |
| Operations (start/stop/restart/status · runtime mute · update · repo moves) | [docs/operations.md](docs/operations.md) |
| Configuration (env files, `PORT`, config paths, provider toggles, deprecated env names) | [docs/configuration.md](docs/configuration.md) |
| Install (human/agent) · dev · dependencies | [docs/install-human.md](docs/install-human.md) · [docs/install-agent.md](docs/install-agent.md) · [docs/development.md](docs/development.md) · [docs/dependencies.md](docs/dependencies.md) |

## Repo map

Essentials below; full layout in [ARCHITECTURE.md](ARCHITECTURE.md).

| Purpose | Path |
|---|---|
| Universal daemon | `core/server.ts` |
| Serial play-queue (202 no-overlap, coalescing, age cap, watchdog) · short-phrase TTS cache | `core/play-queue.ts`, `core/tts-cache.ts` |
| Circuit breaker · numeric env parsing | `core/circuit-breaker.ts`, `core/env.ts` |
| `@echo/shared` workspace package (env loading, notify client, voice-line parsing, persona scaffold, greetings, edge-tts voice grammar, daemon endpoints) | `shared/` |
| Voice / pronunciation config | `core/voices.json`, `core/pronunciations.json` |
| Shared notify client / wire types | `core/notify-client.ts`, `core/types.ts` |
| Claude Code hooks + Stop-hook voice + registrar | `adapters/claudecode/hooks/` (incl. `VoiceCompletion.hook.ts`), `adapters/claudecode/restore-hooks.ts` |
| Host adapter packages (each declares its own dependencies) | `adapters/claudecode/`, `adapters/pi/`, `adapters/omp/` |
| Neutral install/lifecycle | `scripts/` |
| Isolated adapter e2e (never touches the running daemon) | `tests/e2e-adapters.sh` |
| Version · workspace members · changelog | `package.json`, `CHANGELOG.md` |

## Invariants / must not do

- Do not import PAI, Pi, Claude Code, OpenCode, or other host APIs from `core/`.
- Do not add new host-named endpoints to the universal server.
- Do not change the `/notify` request/response contract without an explicit compatibility plan.
- Do not write process state to `/tmp`; use user-owned cache/log/config paths.
- Do not add new `localhost:31337` references; voice server traffic is `:8888`.
- Do not broad-kill whatever owns port `8888`; it may be another service.
- Do not commit secrets or `.env` files.
- Keep daemon and adapter environment-file precedence in `shared/echo-env.ts`; real process values win, then the first configured file per key.
- Do not let an adapter reach outside its own package root. `adapters/*` are workspace packages: every relative import stays inside the package, and shared behavior is imported by name from `@echo/shared` and declared in that adapter's `package.json`. A `../../shared/...` import is a boundary violation, not a shortcut.
- Do not read the daemon's files from an adapter — no `core/voices.json`, no `core/` path of any kind. The daemon may run from another clone or another `VOICES_PATH`, so its own answer is the only correct one: `GET /voices` for configured persona keys. Adapters may import `shared/`, never `core/`.
- Do not duplicate a `core/` invariant into `shared/` with a "keep in sync" note. `shared/` sits below both, so a rule both sides enforce (e.g. the edge-tts voice grammar in `shared/edge-voice.ts`) lives there once and `core/` imports it.
- Do not point a test at the running daemon or its state files. Start an isolated instance (`tests/e2e-adapters.sh`) and prove the target before sending anything.
- Do not register adapter paths append-only. Every adapter ships an idempotent reconcile-and-prune registration — set the canonical path, remove stale variants, edit through symlinks, support `--check` (contract: [docs/adapters.md](docs/adapters.md), #77).
- Do not call `server.stop()` from a test file's `afterAll`. `export const server` in `core/server.ts` is a singleton cached across every test file (Bun module cache); stopping it from one file tears it down for siblings that fetch it — the source of the #47 flake (`port 0` / connection refused, nondeterministic with file order). The ephemeral `PORT=0` server is reclaimed on `bun test` process exit.
- Do not push directly to `master`; work on `dev` and open PRs from `dev` to `master`.

## Agent skills

- **Issue tracker** — draft issues/PRDs locally under `.scratch/<feature>/`, promote to GitHub Issues (`gh`). See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- **Triage labels** — needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See [docs/agents/domain.md](docs/agents/domain.md).

## DOX framework

DOX makes AGENTS.md files binding work contracts for their subtrees. The procedural how-to
(Read Before Editing, Update After Editing, Hierarchy, Child Doc Shape, Style, Closeout)
lives in **[docs/dox.md](docs/dox.md)** — read it before editing any docs.

### Core Contract

- AGENTS.md files are binding work contracts for their subtrees.
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it.
- No child doc may weaken DOX; the closer doc controls local detail, parents control repo-wide rules.
- When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md.

### Child DOX Index

- [`docs/AGENTS.md`](docs/AGENTS.md) owns durable documentation, including canonical plans and
  handoffs under `docs/plans/` and `docs/handoffs/`.

Add another child contract when a folder becomes a durable boundary that needs local rules
(likely candidates: `core/`, `adapters/claudecode/`, `adapters/pi/`, `scripts/`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
