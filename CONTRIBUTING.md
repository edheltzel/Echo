# Contributing

`echo` is a host-neutral localhost TTS daemon plus optional out-of-process adapters.
A good change makes that boundary clearer, safer, or easier to install and verify.

## Assumptions

These are the working assumptions this guide is written against. If one is wrong for
your change, say so in the PR rather than silently widening scope.

- Contributors run macOS and [Bun](https://bun.sh/). There is no npm/npx/node path.
- You have read [`AGENTS.md`](AGENTS.md). It is the binding work contract; this file
  is the human/PR surface of the same rules.
- PRs target `dev`. `master` moves only through a promotion PR that Ed merges.
- The `verify` GitHub Actions workflow is the pre-merge gate. A red or missing check
  means the PR is not ready.
- Tests never touch the installed daemon on `:3246`. Isolated ports only.
- One concern per PR. Release metadata (`package.json` version, generated
  `CHANGELOG.md`, tags) belongs on a promotion/release change, not a feature branch.
- The live operator install is off limits. Do not restart, retarget, or speak through
  the running LaunchAgent to "check your work."

## Before you start

```bash
git checkout dev
bun install                 # required: adapters resolve @echo/shared through workspace links
cli/echo doctor             # or: bash scripts/install.sh --check
```

`bun install` is not optional. Skip it and a registered adapter fails to load.
`--check` prints one harness section with `[x]` / `[\]` / `[ ]` for complete,
partial, and missing LaunchAgent, workspace link, and adapter registration.

## Code style

- TypeScript. Prefer `import`; do not add CommonJS `require`.
- Keep `core/` host-neutral. Host lifecycle belongs in an adapter that POSTs `/notify`.
- Do not add Python under `core/`. Python is only an out-of-process `edge-tts` dependency.
- Use a plain dash (`-`), never an em dash, in code, comments, strings, and docs.
  Where the characters themselves matter (for example the separator-stripping regex
  in `shared/voice-line.ts`), write them as unicode escapes. Generated `CHANGELOG.md`
  is exempt.
- Do not write process state to `/tmp`. Use user-owned cache/log/config paths.
- Do not commit secrets or `.env` files. `ELEVENLABS_API_KEY` never belongs in
  `config.json`. See [`SECURITY.md`](SECURITY.md).

## Commit format

Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`. Short imperative
subject. One concern per commit when the history will be reviewed as-is.

## Pull requests

1. Branch from current `dev`.
2. One concern. Link the issue.
3. Add or update tests when behavior changes. A new observable contract needs a test
   that would fail if the contract were broken.
4. Update the nearest docs when providers, adapters, install, or HTTP contracts change.
   Documentation edits follow [`docs/dox.md`](docs/dox.md).
5. Do not hand-write `CHANGELOG.md` on a feature branch.
6. Wait for `verify` to pass. That job is:

   - `bun install --frozen-lockfile`
   - `bun test`
   - `PORT=8889 tests/smoke-core.sh`
   - `ECHO_E2E_PORT=8899 tests/e2e-adapters.sh`
   - `ECHO_E2E_PORT=8921 ECHO_E2E_CONVERSE_PORT=8922 tests/e2e-converse.sh`
   - bun builds for the pi, omp, mcp, jcode, grok, and codex adapters

Local equivalent: [`docs/development.md`](docs/development.md). Spoken test lines begin
`Echo Test engaged. Beep, boop, bop.` so anything audible is unmistakably a test.

GitHub requires the `verify` check on PRs into `dev` and `master`. The branch must
be up to date with the base, and admins cannot bypass a red, pending, or stale
check. Direct pushes are still possible; do not use them.

## Branching and releases

Work on `dev`. Open PRs into `dev`. Never push directly to `master`. Ed owns merges.

Release flow - version bump, generated changelog, `dev` to `master` promotion
(merge commit, never squash), tag `vX.Y.Z`, GitHub release - lives in
[`AGENTS.md`](AGENTS.md) under *Release & versioning*. Read it before preparing a
release. After a squash promotion, restore `master` as an ancestor of `dev` immediately.

## Issue filing

Use this shape when possible:

- Summary
- For Humans
- For AI Agents
- Acceptance criteria
- Constraints / non-goals

Labels follow the namespaced taxonomy in [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

## Scope

In scope: TTS server core, host adapters, TTS providers, `converse/` voice ask with
local speech-to-text, packaging, install and development docs, smoke and isolated e2e.

Out of scope: cloud speech-to-text, voice cloning UI, exposing the daemon off
localhost, and unrelated coding-agent features.

## Adding a host adapter

1. Create `adapters/<host>/` as a workspace package: its own `package.json` declaring
   `@echo/shared`, listed in the root `workspaces` array. Relative imports stay inside
   the package. The daemon's config is read over HTTP, never off disk. Contract:
   [`docs/adapters.md`](docs/adapters.md).
2. Translate host lifecycle events into `/notify` payloads.
3. Include `source` and `session_id` when available.
4. Keep host-specific settings and paths inside the adapter.
5. Add install support in `scripts/install.sh --adapter <host>`. Registration must be
   an idempotent reconcile-and-prune (set the canonical path, remove stale variants,
   support `--check`) - never append-only. The contract lives in
   [`docs/adapters.md`](docs/adapters.md) (#77).
6. Add tests and a docs section in [`docs/dependencies.md`](docs/dependencies.md).

Copy `adapters/pi/` as the first non-Claude-Code reference, then `adapters/omp/` for
the extension-symlink pattern.

## Code of conduct

Be direct, respectful, and evidence-driven in issues and PRs. Argue from files,
commands, and observed behavior. Do not paste secrets, live transcripts, or
operator config into a public issue.
