# AGENTS.md

Lean entry point for agents working on `atlas-voicesystem`. This file is the build/test
commands, the repo map, the hard invariants, and the DOX rail. Architecture and per-area
detail live behind the pointers below — load them on demand (progressive disclosure).

## Architecture in one breath

A host-neutral daemon (`core/server.ts`, listening on `localhost:8888`) speaks text POSTed to
`POST /notify`; hosts integrate **out-of-process** via adapters that never import `core/`.
Full codemap, boundaries, request/voice flow, and cross-cutting concerns:
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

- Universal server core: `core/server.ts`, `core/voices.json`, `core/pronunciations.json`
- Shared HTTP client/types/schema: `core/notify-client.ts`, `core/types.ts`, `core/voices-schema.json`
- PAI adapter: `adapters/pai/` · Pi adapter: `adapters/pi/`
- Neutral lifecycle scripts: `scripts/{install,start,stop,restart,status,uninstall}.sh`
- Historical PAI stow path: `claudecode/.claude/PAI/USER/Voice/` — compatibility wrappers/legacy config only.

Do **not** add host-specific logic to `core/`. Host lifecycle behavior belongs in an adapter
that calls `POST /notify`.

## Quick commands

```bash
# Install (core only / with a host adapter)
bash scripts/install.sh --adapter none
bash scripts/install.sh --adapter pai
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
resurrect the old service from compatibility scripts.

## Development workflow

```bash
git checkout dev
bun test
PORT=8889 tests/smoke-core.sh
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/atlas-pi-adapter-build
```

After changing `core/server.ts`, restart the neutral service:

```bash
launchctl kickstart -k "gui/$UID/com.atlas.voicesystem"
tail -f ~/Library/Logs/atlas-voicesystem.log
```

Use **Bun only** — no npm/npx/node-based workflows. Run `bun test` + the smoke + the Pi build
before shipping. PAI-wrapper smoke checks are in [docs/adapters.md](docs/adapters.md).

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
| Adapter rules + Pi #15 + PAI compatibility path | [docs/adapters.md](docs/adapters.md) |
| Shipped design decisions | [docs/design-docs/index.md](docs/design-docs/index.md) |
| Install (human / agent) · dev · dependencies | [docs/install-human.md](docs/install-human.md) · [docs/install-agent.md](docs/install-agent.md) · [docs/development.md](docs/development.md) · [docs/dependencies.md](docs/dependencies.md) |

## Repo map

| Purpose | Path |
|---|---|
| Universal daemon | `core/server.ts` |
| Provider circuit breaker | `core/circuit-breaker.ts` |
| Numeric env parsing | `core/env.ts` |
| Voice config | `core/voices.json` |
| Pronunciation config | `core/pronunciations.json` |
| Shared notify client / wire types | `core/notify-client.ts`, `core/types.ts` |
| PAI hooks | `adapters/pai/hooks/` |
| Per-turn voice (Stop hook) + handler | `adapters/pai/hooks/VoiceCompletion.hook.ts`, `adapters/pai/hooks/handlers/VoiceNotification.ts` |
| Transcript parsing (PAI) | `adapters/pai/hooks/lib/{hook-io,TranscriptParser}.ts` |
| PAI hook registration | `adapters/pai/restore-hooks.ts` |
| Pi extension package | `adapters/pi/` |
| Neutral install/lifecycle | `scripts/` |
| Migration notes | `MIGRATIONS.md` |
| Project version / changelog | `package.json` (root), `CHANGELOG.md` |

## Invariants / must not do

- Do not import PAI, Pi, Claude Code, OpenCode, or other host APIs from `core/`.
- Do not add new PAI-named endpoints to the universal server.
- Do not change the `/notify` request/response contract without an explicit compatibility plan.
- Do not write process state to `/tmp`; use user-owned cache/log/config paths.
- Do not add new `localhost:31337` references; voice server traffic is `:8888`.
- Do not broad-kill whatever owns port `8888`; it may be another service.
- Do not commit secrets or `.env` files.
- Do not call `server.stop()` from a test file's `afterAll`. `export const server` in `core/server.ts` is a singleton cached across every test file (Bun module cache); stopping it from one file tears it down for siblings that fetch it — the source of the #47 flake (`port 0` / connection refused, nondeterministic with file order). The ephemeral `PORT=0` server is reclaimed on `bun test` process exit.
- Do not push directly to `master`; work on `dev` and open PRs from `dev` to `master`.

## Agent skills

- **Issue tracker** — hybrid: draft issues/PRDs locally under `.scratch/<feature>/`, promote to GitHub Issues (`gh`) as the canonical shared tracker. See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- **Triage labels** — default vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- **Domain docs** — single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See [docs/agents/domain.md](docs/agents/domain.md).

## DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

### Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it

### Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path, read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules
7. If docs conflict, the closer doc controls local work details, but no child doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.

### Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.

### Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Each parent explains what its direct children cover and what stays owned by the parent
- The closer a doc is to the work, the more specific and practical it must be

### Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user instructions; if there are no specific standards or instructions yet, leave it empty
- Verification must reflect an existing check; if no verification framework exists yet, leave it empty and update it when one exists

Default section order:
- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

### Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for risks that no longer exist

### Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

### User Preferences

When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md.

### Child DOX Index

This repository is single-context: the root `AGENTS.md` is the sole DOX contract — there are no child `AGENTS.md` files yet. Add one when a folder becomes a durable boundary that needs its own contract (likely candidates: `core/`, `adapters/pai/`, `adapters/pi/`, `scripts/`).
