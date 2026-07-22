# Contributing

## Welcome

`echo` is a universal text-to-speech notification server plus optional host adapters. Contributions should make that boundary clearer, safer, or easier to install.

## Code Style

- Use Bun for runtime and tests.
- Use TypeScript.
- Prefer `import` syntax; do not add CommonJS `require`.
- Keep universal code under `core/` host-neutral.
- Do not add Python code under `core/`; Python is only an out-of-process provider dependency for edge-tts.

## Commit Format

Conventional Commits are encouraged: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. Keep subjects short and imperative.

## PR Process

- One concern per PR.
- Link the issue.
- Add or update tests when behavior changes.
- Update dependency/install docs when providers, adapters, or install flows change.

## Branching & Releases

Work happens on `dev`: open PRs into `dev`, never push directly to `master`, and Ed owns
all merges. The authoritative release flow — versioning, changelog, `dev`→`master`
promotion PRs, and tagging — lives in [`AGENTS.md`](AGENTS.md) → *Release & versioning*;
read it before preparing a release.

## Issue Filing

Use the repo's issue shape when possible:

- Summary
- For Humans
- For AI Agents
- Acceptance criteria
- Constraints / non-goals

## Scope

In scope: TTS server core, host adapters, TTS providers, packaging, install/development docs, smoke tests.

Out of scope: speech-to-text, voice cloning UI, and unrelated coding-agent features.

## Adding a Host Adapter

1. Create `adapters/<host>/` as a workspace package: its own `package.json` declaring
   `@echo/shared`, listed in the root `workspaces` array. Relative imports must stay inside
   the package root, and the daemon's config is read over HTTP, never off disk — the package
   boundary contract lives in [`docs/adapters.md`](docs/adapters.md).
2. Translate host lifecycle events into `/notify` payloads.
3. Include `source` and `session_id` when available.
4. Keep host-specific settings and paths inside the adapter.
5. Add install support in `scripts/install.sh --adapter <host>`. Registration must be an
   idempotent reconcile-and-prune (set the canonical path, remove stale variants, support
   `--check`) — never append-only. The contract lives in [`docs/adapters.md`](docs/adapters.md)
   (#77).
6. Add tests and a docs section in `docs/dependencies.md`.

Use `adapters/pi/` as the first non-Claude-Code reference implementation.

## Code of Conduct

TBD. Be direct, respectful, and evidence-driven in issues and PRs.
