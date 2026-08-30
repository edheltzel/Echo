# AGENTS.md

Lean entry point for agents working on `echo`. This file is the build/test
commands, the repo map, the hard invariants, and the DOX rail. Architecture and per-area
detail live behind the pointers below - load them on demand (progressive disclosure).

## Architecture in one breath

A host-neutral daemon (`core/server.ts`, listening on `localhost:3246` by default) speaks text POSTed to
`POST /notify`; hosts integrate **out-of-process** via adapters (`adapters/claudecode/`,
`adapters/pi/`, `adapters/grok/`) that never import `core/`. Full codemap,
boundaries, request/voice flow, and cross-cutting concerns: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

Do **not** add host-specific logic to `core/`. Host lifecycle behavior belongs in an adapter
that calls `POST /notify`.

A second host-neutral capability, `echo-converse` (`converse/`, `localhost:32468`), adds the
  other direction: speak a question, capture the spoken reply, transcribe it locally, return the
  text. It uses an additive opt-in completion/reservation protocol in `core/` while preserving
  ordinary `/notify` callers, and writes the capture-state file `core/capture-guard.ts` already
  reads. Its coordinator is deliberately microphone-free;
the calling host opens the microphone. Why, and the TCC measurements behind it:
**[docs/converse.md](docs/converse.md)**.

## Quick commands

```bash
# Link the workspace (adapters resolve @echo/shared through it)
bun install

# Stable human surface - cli/echo wraps the scripts + daemon API (never reimplements them)
cli/echo install [--adapter none|claudecode|jcode|grok|codex|mcp|pi|omp|opencode] [--check]
cli/echo doctor              # canonical "did my install work" check; recovery cmd per row
cli/echo status
cli/echo mute on|off|toggle|status | 30m|1h
/echo-mute [on|off|toggle|status|duration]  # bare toggles; affects every Echo session
cli/echo voice <name> <edge-tts-voice-id>   # default pi/omp persona → ~/.config/echo/config.json
cli/echo update [--check]    # re-stage payload + reload
cli/echo uninstall [--check]

# Underlying scripts (cli/echo delegates to these)
bash scripts/install.sh --adapter none        # or claudecode|jcode|grok|codex|pi|omp|mcp|opencode
bash scripts/{status,start,stop,restart,uninstall}.sh

# Runtime mute (audio off; notifications still processed + logged)
bash scripts/mute.sh on|off|toggle|status   # `on 30` = timed; empty POST /mute toggles

# echo-converse (one-shot voice ask) - coordinator only; hosts call the echo_ask tool
bun converse/main.ts                     # start the coordinator on :32468 (no LaunchAgent by design)
curl -fsS http://localhost:32468/health  # capability, booking holder, configured core address
bash scripts/install.sh --adapter mcp    # register the ask tool for Claude Code

# Health / silent smoke
curl -fsS http://localhost:3246/health
curl -fsS -X POST http://localhost:3246/notify \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false}'
```

Service identity:

- LaunchAgent label: `com.echo`
- Plist: `~/Library/LaunchAgents/com.echo.plist`
- Log: `~/Library/Logs/echo.log`
- Daemon payload: `~/Library/Application Support/echo/payload/versions/<v>` (a self-contained copy of
  `core/` + `shared/`); the plist points at the `current` symlink, **not** the git checkout, so
  moving or deleting the clone never breaks the running service. Adapters still run from the
  checkout and heal on the next `install` (#77).

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
tests/e2e-converse.sh       # isolated core :8921 + coordinator :8922; no microphone needed
bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/echo-pi-build
bun build adapters/omp/index.ts --target=bun --external @oh-my-pi/pi-coding-agent --outdir /tmp/echo-omp-build
bun build adapters/mcp/server.ts --target=bun --outdir /tmp/echo-mcp-build
bun build adapters/jcode/hook.ts --target=bun --outdir /tmp/echo-jcode-build
bun build adapters/grok/hook.ts --target=bun --outdir /tmp/echo-grok-build
bun build adapters/codex/hook.ts --target=bun --outdir /tmp/echo-codex-build
bun build adapters/opencode/plugin.ts --target=bun --outdir /tmp/echo-opencode-build
```

**`bun install` is a prerequisite, not an optimization.** Adapters resolve `@echo/shared`
through their own `node_modules`; without the workspace links a registered adapter fails to
load. `scripts/install.sh` runs it, and `--check` reports a missing link as stale. A test
that drives `install.sh` must set `ECHO_SKIP_WORKSPACE_LINK=1` - the flag opts that run out
of both creating and verifying the links, so `bun test` never relinks the checkout's
`node_modules` underneath itself.

**Never test against the running daemon.** It serves the operator's real notifications, so
restarting it, retargeting it, or speaking through it is a live-system incident.
`tests/e2e-adapters.sh` starts its own instance on its own port with every state path
(mute, capture, audio cache, TTS cache, lifecycle log, `VOICES_PATH`) redirected to scratch,
refuses to attach to a port it does not own, and prints an isolation proof before sending
anything. Spoken test lines begin `Echo Test engaged. Beep, boop, bop.` so anything audible
is unmistakably a test. `bun test` preloads `tests/preload.ts` (via `bunfig.toml`), which
pins `ECHO_CONFIG_FILE` to a scratch path: config.json is authoritative over live process
values, so without the pin the operator's real config.json would override the isolation env
in-process tests set before importing the singleton server. A test that models config.json
writes its own file and points `ECHO_CONFIG_FILE` at it.

After changing `core/server.ts`, re-stage: `cli/echo update` (tail `~/Library/Logs/echo.log`).
A bare `launchctl kickstart -k "gui/$UID/com.echo"` reloads the *staged payload* and so
restarts the old code; it only applies changes the daemon reads from outside the payload,
such as the JSON config file. Use **Bun only** - no npm/npx/node. Run
`bun test` + the smoke + both e2e scripts + the Pi, omp, MCP, Jcode, Grok, Codex, and OpenCode builds before shipping; CI
machine-runs the same set on every PR into `dev`/`master` (`.github/workflows/verify.yml`).

## Release & versioning

Project version lives in the root `package.json`. `scripts/install.sh` reads it (via `sed`,
no bun) to name the versioned daemon payload dir; nothing at daemon runtime reads it.
`CHANGELOG.md` is generated from tags and merged-PR history at release time, following the
[Keep a Changelog](https://keepachangelog.com/) + [SemVer](https://semver.org/) format; do not
hand-write it. Contributors and agents must not add or edit entries on a feature branch.
**Flow:** work on `dev` → PR into `dev` → reviewer sign-off
→ **Ed merges** → `dev`→`master` promotion PR → tag `vX.Y.Z` + GitHub release. **Ed owns all
merges; never push directly to `master`** (see Invariants).

**Promotion PRs must be merge-committed, never squashed.** Squashing a `dev`→`master`
promotion collapses the merge and drops `dev` from `master`'s ancestry, recreating the
divergence that makes the *next* promotion phantom-conflict (bit us on #74). If a promotion is
squashed anyway, immediately resync with a real merge commit: `git merge origin/master` into
`dev` (favor master's version/CHANGELOG) and push `dev`, restoring `master` as an ancestor.

## Documentation map

| Topic | Doc |
| --- | --- |
| Architecture codemap, boundaries, invariants | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Security model (trust boundary, egress, secrets) | [SECURITY.md](SECURITY.md) |
| HTTP API: every endpoint, the request/response contract, rate-limit buckets + mute hotkey bindings | [docs/http-api.md](docs/http-api.md) |
| Provider egress gating + drop-off log (#24) | [docs/providers-observability.md](docs/providers-observability.md) |
| Circuit breaker + reliability settings | [docs/reliability.md](docs/reliability.md) |
| Voices, audition, per-turn persona voice (Stop hook) + the `voices.json` / `pronunciations.json` reference | [docs/voices.md](docs/voices.md) |
| Adapter rules + package boundary + registration contract (#77) + Pi #15 + oh-my-pi #18/#109 | [docs/adapters.md](docs/adapters.md) |
| One-shot voice ask: TCC process topology, the turn, endpoints, capture tiers, v1 limits | [docs/converse.md](docs/converse.md) |
| Shipped design decisions | [docs/design-docs/index.md](docs/design-docs/index.md) |
| Implementation plans · session handoffs | [docs/plans/](docs/plans/) · [docs/handoffs/](docs/handoffs/) |
| Documentation ownership contract · DOX procedure | [docs/AGENTS.md](docs/AGENTS.md) · [docs/dox.md](docs/dox.md) |
| Getting started (first install → first spoken notification) | [docs/getting-started.md](docs/getting-started.md) |
| Operations (start/stop/restart/status · runtime mute · update · repo moves) | [docs/operations.md](docs/operations.md) |
| Configuration (`~/.config/echo/config.json`, schema, migration, provider toggles) | [docs/configuration.md](docs/configuration.md) |
| Install (human/agent) · dev · dependencies | [docs/install-human.md](docs/install-human.md) · [docs/install-agent.md](docs/install-agent.md) · [docs/development.md](docs/development.md) · [docs/dependencies.md](docs/dependencies.md) |

## Repo map

Essentials below; full layout in [ARCHITECTURE.md](ARCHITECTURE.md).

| Purpose | Path |
| --- | --- |
| Universal daemon | `core/server.ts` |
| Serial play-queue (202 no-overlap, coalescing, age cap, watchdog) · short-phrase TTS cache | `core/play-queue.ts`, `core/tts-cache.ts` |
| Circuit breaker · numeric config parsing | `core/circuit-breaker.ts`, `core/env.ts` |
| `@echo/shared` workspace package (config loading, notify client, native terminal visual routing, voice-line parsing, persona and mute commands, greetings, edge-tts voice grammar, daemon endpoints) | `shared/` |
| Voice / pronunciation config | `core/voices.json`, `core/pronunciations.json` |
| Shared notify client / wire types | `core/notify-client.ts`, `core/types.ts` |
| Claude Code hooks, slash commands + reconcilers | `adapters/claudecode/hooks/`, `adapters/claudecode/commands/`, `adapters/claudecode/{restore-hooks,reconcile-commands}.ts` |
| Host adapter packages (each declares its own dependencies) | `adapters/claudecode/`, `adapters/jcode/`, `adapters/grok/`, `adapters/codex/`, `adapters/opencode/`, `adapters/pi/`, `adapters/omp/`, `adapters/mcp/` |
| `@echo/converse` one-shot voice ask: mic-free coordinator (`:32468`) · booking lock · capture + local STT in the caller · the shared `echo_ask` tool | `converse/` (contract: `converse/AGENTS.md`) |
| MCP server + registrar for Claude Code (hooks structurally cannot return a transcript) | `adapters/mcp/` |
| Neutral install/lifecycle · clone-independent payload staging · rollback on an unhealthy reload | `scripts/` (`install.sh` `stage_payload`, `rollback_payload`) |
| Port every lifecycle script + `cli/echo` talks to (config.json, deprecated process PORT, then 3246; never parses dotenv files) | `scripts/echo-port.sh` |
| Stable `echo` control/diagnostic CLI · default-persona writer · dotenv→JSON config migration | `cli/echo`, `scripts/set-default-voice.ts`, `scripts/migrate-config.ts` |
| Isolated adapter e2e (never touches the running daemon) | `tests/e2e-adapters.sh` |
| Isolated voice-ask e2e (own core + own coordinator, stand-in recorder) | `tests/e2e-converse.sh` |
| Version · workspace members · changelog | `package.json`, `CHANGELOG.md` |

## Invariants / must not do

- Do not import PAI, Pi, Claude Code, OpenCode, or other host APIs from `core/`.
- Do not add new host-named endpoints to the universal server.
- Do not change the `/notify` request/response contract without an explicit compatibility plan.
- Do not write process state to `/tmp`; use user-owned cache/log/config paths.
- Do not add new `localhost:31337` references; voice server traffic is `:3246`.
- Do not broad-kill whatever owns port `3246`; it may be another service.
- Do not commit secrets or `.env` files.
- Do not write file config into `process.env`. Core resolves config through
  `resolveEchoEnv` (`core/env.ts`) - read-only, with config.json authoritative. Hydrating `process.env` at
  import leaked the operator's `ECHO_VOICE_*` identity into same-process adapter tests
  (the pi-adapter "Atlas" pollution, a #47-class file-order hazard); guarded by
  `tests/core/architecture-invariants.test.ts` (source scan) plus
  `tests/core/import-purity.test.ts` (isolated import of the daemon proves nothing leaks).
- Keep daemon and adapter configuration precedence in `shared/echo-env.ts`: `~/.config/echo/config.json` wins, followed for one release by deprecated process and legacy dotenv fallbacks. `PORT` is never read from dotenv, and `ELEVENLABS_API_KEY` is never accepted from config.json. Test-only environment injection remains plumbing, not user configuration; the complete classification is recorded in the configuration audit commit and summarized in `docs/configuration.md`.
- Do not make one bad key in `config.json` discard the file. Validation drops only the offending keys, keeps every other setting, and reports what it dropped through `GET /health` (`config.ignored_keys`).
- Do not let an adapter reach outside its own package root. `adapters/*` are workspace packages: every relative import stays inside the package, and shared behavior is imported by name from `@echo/shared` and declared in that adapter's `package.json`. A `../../shared/...` import is a boundary violation, not a shortcut.
- Do not read the daemon's files from an adapter - no `core/voices.json`, no `core/` path of any kind. The daemon may run from another clone or another `VOICES_PATH`, so its own answer is the only correct one: `GET /voices` for configured persona keys. Adapters may import `shared/`, never `core/`.
- Do not duplicate a `core/` invariant into `shared/` with a "keep in sync" note. `shared/` sits below both, so a rule both sides enforce (e.g. the edge-tts voice grammar in `shared/edge-voice.ts`) lives there once and `core/` imports it.
- Do not point a test at the running daemon or its state files. Start an isolated instance (`tests/e2e-adapters.sh`) and prove the target before sending anything.
- Do not register adapter paths append-only. Every adapter ships an idempotent reconcile-and-prune registration - set the canonical path, remove stale variants, edit through symlinks, support `--check` (contract: [docs/adapters.md](docs/adapters.md), #77).
- Do not call `server.stop()` from a test file's `afterAll`. `export const server` in `core/server.ts` is a singleton cached across every test file (Bun module cache); stopping it from one file tears it down for siblings that fetch it - the source of the #47 flake (`port 0` / connection refused, nondeterministic with file order). The ephemeral `PORT=0` server is reclaimed on `bun test` process exit.
- Do not let an always-on process open the microphone. macOS attributes a microphone request to the responsible process, and a background service gets none: a spike measured "Failed to fetch responsible file descriptor", no prompt surface and no grant, while the same capture spawned from the host terminal attributed to the terminal app and delivered audio. So `echo-converse`'s coordinator books and sequences, the calling host captures, and there is no LaunchAgent for it. Source-level regression checks in `tests/converse/architecture-invariants.test.ts` catch direct coordinator capture imports and subprocess calls; they are not runtime ancestry enforcement.
- Do not let `echo_ask` reach capture without a live host-session consent grant. Pi and omp keep the grant only in their active extension instance; MCP keeps it only for its stdio process because the protocol publishes no narrower conversation lifecycle. Denials are sticky for that session, missing UI fails closed, and no consent state is persisted. Exact surfaces and expiry: `docs/converse.md`.
- Do not speak a converse question while capture state is non-idle, and do not open the microphone before this request's playback completes and core grants its reservation. The coordinator generates the reservation id before `/notify`, releases it on every pre-grant exit, and rebases both core and booking leases at the capture grant. Core's guard would otherwise hold back the question, or a lost response could strand playback. The capture owner writes its OWN pid because core honors a non-idle state only while that pid is alive.
- Do not push directly to `master`; work on `dev` and open PRs from `dev` to `master`.

## Agent skills

- **Issue tracker** - draft issues/PRDs locally under `.scratch/<feature>/`, promote to GitHub Issues (`gh`). See [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- **Triage labels** - namespaced taxonomy shared with Recall: `type:`, `agent:`, `needs:`/`needs-triage`/`needs-info`, `risk:`, `blocked:`, `wontfix`. See [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- **Domain docs** - single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See [docs/agents/domain.md](docs/agents/domain.md).

## DOX framework

DOX makes AGENTS.md files binding work contracts for their subtrees. The procedural how-to
(Read Before Editing, Update After Editing, Hierarchy, Child Doc Shape, Style, Closeout)
lives in **[docs/dox.md](docs/dox.md)** - read it before editing any docs.

### Core Contract

- AGENTS.md files are binding work contracts for their subtrees.
- Work products, source materials, instructions, records, assets, and durable docs must stay understandable from the nearest applicable AGENTS.md plus every parent AGENTS.md above it.
- No child doc may weaken DOX; the closer doc controls local detail, parents control repo-wide rules.
- When the user requests a durable behavior change, record it here or in the relevant child AGENTS.md.

### Child DOX Index

- [`docs/AGENTS.md`](docs/AGENTS.md) owns durable documentation, including canonical plans and
  handoffs under `docs/plans/` and `docs/handoffs/`.
- [`converse/AGENTS.md`](converse/AGENTS.md) owns the `@echo/converse` voice-ask capability: the
  microphone-free coordinator, the caller-side capture, and the local contracts that keep the
  two apart.

Add another child contract when a folder becomes a durable boundary that needs local rules
(likely candidates: `core/`, `adapters/claudecode/`, `adapters/pi/`, `scripts/`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
