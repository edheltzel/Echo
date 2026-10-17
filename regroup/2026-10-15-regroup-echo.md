# Regroup: Echo

Date: 2026-10-15
Sources: GitHub PRs, issues and git history for edheltzel/Echo; repo `todo.txt`. Previous file: `2026-10-14-regroup-echo.md`.
Resume point: `docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md` (this repo keeps handoffs in `docs/handoffs/`, not `docs/plans/handoffs/`).

## Last completed

- 2026-10-15: #230 dev to master promotion merged (`2152491`). It was squash-merged: one parent, so dev is no longer an ancestor of master.
- 2026-10-15: #229 handoff and regroup landed in dev (`0ea9c9e`) after No Mistakes checks-passed.
- 2026-10-15: #228 package scripts landed in dev (`0d93361`) after No Mistakes checks-passed.
- 2026-10-15: stray remote branch `promote/dev-to-master-2026-10-15` deleted.

## Up next

- Resync dev with master using a real merge commit (AGENTS.md: a squashed promotion must be followed by `git merge origin/master` into dev). Not started.
- Add the `no-mistakes axi run --yes` workflow rule to AGENTS.md. Not started.

## Remaining

- Fix `cli/echo doctor` reporting a /health 429 as a foreign port owner. Not started.
- Fix `cli/echo --help` backticks being evaluated by the shell. Not started.
- Trial Pocket TTS through the Kokoro endpoint on an isolated daemon. Not started.
- #8 npm install/update: blocked on package name, Bun bootstrap and publish flow.
- #28 zero-touch docs: blocked on #8.
- #17 OpenCode headless greeting check: needs a live session.
- #30 agent-agnostic epic: closes with #17.
- #126, #179, #180, #181, #195: backlogged.
- ATL-632 xAI TTS: not started. ATL-633 daemon-owned notice: blocked on Ed naming the mechanism.
- Repo `todo.txt` still lists items GitHub shows done (#129, #191, #95, #96, #194, #106, #213, the promotions); Ed to clear.
