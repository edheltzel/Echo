# AGENTS.md

Lean entry point for agents working on `atlas-voicesystem`. This file is the build/test
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
# Install (core only / with a host adapter)
bash scripts/install.sh --adapter none
bash scripts/install.sh --adapter claudecode
bash scripts/install.sh --adapter pi

# Lifecycle
bash scripts/{status,start,stop,restart,uninstall}.sh

# Health / silent smoke
curl -fsS http://localhost:8888/health
curl -fsS -X POST http://localhost:8888/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'
```

Service identity:

- LaunchAgent label: `com.atlas.voicesystem`
- Plist: `~/Library/LaunchAgents/com.atlas.voicesystem.plist`
- Log: `~/Library/Logs/atlas-voicesystem.log`

The installer unloads and quarantines the old `com.pai.voice-server` plist if found. Do not
resurrect the old service.

## Development workflow

```bash
git checkout dev
bun test
PORT=8889 tests/smoke-core.sh
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/atlas-pi-adapter-build
```

After changing `core/server.ts`, restart: `launchctl kickstart -k "gui/$UID/com.atlas.voicesystem"`
(tail `~/Library/Logs/atlas-voicesystem.log`). Use **Bun only** — no npm/npx/node. Run
`bun test` + the smoke + the Pi build before shipping.

## Release & versioning

Project version lives in the root `package.json` (declarative metadata only — no code reads
it). Track notable changes in `CHANGELOG.md` ([Keep a Changelog](https://keepachangelog.com/)
+ [SemVer](https://semver.org/)). **Flow:** work on `dev` → PR into `dev` → reviewer sign-off
→ **Ed merges** → `dev`→`master` promotion PR → tag `vX.Y.Z` + GitHub release. **Ed owns all
merges; never push directly to `master`** (see Invariants).

## Documentation map

| Topic | Doc |
|---|---|
| Architecture codemap, boundaries, invariants | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Security model (trust boundary, egress, secrets) | [SECURITY.md](SECURITY.md) |
| HTTP API (`/notify`, `/notify/personality`, `/health`) | [docs/http-api.md](docs/http-api.md) |
| Provider egress gating + drop-off log (#24) | [docs/providers-observability.md](docs/providers-observability.md) |
| Circuit breaker + reliability env knobs | [docs/reliability.md](docs/reliability.md) |
| Voices + per-turn persona voice (Stop hook) | [docs/voices.md](docs/voices.md) |
| Adapter rules + Pi #15 | [docs/adapters.md](docs/adapters.md) |
| Shipped design decisions | [docs/design-docs/index.md](docs/design-docs/index.md) |
| DOX procedure (read before editing docs) | [docs/dox.md](docs/dox.md) |
| Install (human/agent) · dev · dependencies | [docs/install-human.md](docs/install-human.md) · [docs/install-agent.md](docs/install-agent.md) · [docs/development.md](docs/development.md) · [docs/dependencies.md](docs/dependencies.md) |

## Repo map

Essentials below; full layout in [ARCHITECTURE.md](ARCHITECTURE.md).

| Purpose | Path |
|---|---|
| Universal daemon | `core/server.ts` |
| Circuit breaker · env parsing | `core/circuit-breaker.ts`, `core/env.ts` |
| Voice / pronunciation config | `core/voices.json`, `core/pronunciations.json` |
| Shared notify client / wire types | `core/notify-client.ts`, `core/types.ts` |
| Claude Code hooks + Stop-hook voice + registrar | `adapters/claudecode/hooks/` (incl. `VoiceCompletion.hook.ts`), `adapters/claudecode/restore-hooks.ts` |
| Pi extension package | `adapters/pi/` |
| Neutral install/lifecycle | `scripts/` |
| Version · changelog | `package.json`, `CHANGELOG.md` |

## Invariants / must not do

- Do not import PAI, Pi, Claude Code, OpenCode, or other host APIs from `core/`.
- Do not add new host-named endpoints to the universal server.
- Do not change the `/notify` request/response contract without an explicit compatibility plan.
- Do not write process state to `/tmp`; use user-owned cache/log/config paths.
- Do not add new `localhost:31337` references; voice server traffic is `:8888`.
- Do not broad-kill whatever owns port `8888`; it may be another service.
- Do not commit secrets or `.env` files.
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

This repository is single-context: the root `AGENTS.md` is the sole DOX contract — there are no child `AGENTS.md` files yet. Add one when a folder becomes a durable boundary that needs its own contract (likely candidates: `core/`, `adapters/claudecode/`, `adapters/pi/`, `scripts/`).
