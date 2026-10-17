# Regroup: Echo

Date: 2026-10-15
Sources: GitHub PRs, issues and git history for edheltzel/Echo; repo `todo.txt`. Previous file: [2026-10-14-regroup-echo.md](2026-10-14-regroup-echo.md).
Resume point: [handoff](../docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md).

## Last completed

- 2026-10-15: #230 dev to master promotion merged (`2152491`); see [done.txt](../done.txt) for the promotion outcome and ancestry repair.
- 2026-10-15: #229 handoff and regroup landed in dev (`0ea9c9e`) after No Mistakes checks-passed.
- 2026-10-15: #228 package scripts landed in dev (`0d93361`) after No Mistakes checks-passed.
- 2026-10-15: stray remote branch `promote/dev-to-master-2026-10-15` deleted.

## Up next

- Promotion validation: follow the waiting task in [todo.txt](../todo.txt).
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
- Task cleanup outcomes are recorded in [done.txt](../done.txt).
