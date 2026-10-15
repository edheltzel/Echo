# Regroup: Echo

Date: 2026-10-14
Sources: GitHub issues, PRs, tags and releases for edheltzel/Echo; repo `todo.txt`; `~/todo.txt` `+echo` lines. Previous file: `2026-10-09-regroup-echo-3.md`.

## Last completed

- 2026-10-15 (UTC): #228 package.json scripts (`npm|pnpm|bun|vp run update` and the rest) landed in dev as `0d93361`, after No Mistakes `checks-passed`.
- 2026-10-14: local daemon updated to v0.12.0 (payload `versions/0.12.0`); edge-tts fixed by installing it into Homebrew Python 3.15.
- 2026-10-10: v0.12.0 tagged on master `7b79250` and released.

## Up next

- Promote dev to master again: #226, #227 and #228 are on dev only.
- #8 npm install/update: blocked on package name, Bun required or bootstrapped, and publish flow.

## Remaining

- #28 zero-touch docs: blocked on #8.
- #17 OpenCode: headless `opencode run` greeting check; needs a live session.
- #30 agent-agnostic epic: closes with #17.
- #126 meeting detection: backlogged.
- #179, #180, #181, #195: backlogged ideas.
- Pocket TTS local provider trial: not started; Ed is leaning toward it (no issue yet).
- ATL-632 xAI TTS provider: not started; an OpenAI or xAI voice needs a separate API key and is billed separately from the subscription.
- ATL-633 daemon-owned notice: blocked on Ed naming the mechanism.
- `cli/echo doctor` mislabels a /health 429 as a foreign port owner: not started.
- `cli/echo --help` evaluates backticks (`all: command not found`): not started.
- Repo `todo.txt` still lists items GitHub shows done (#129, #191, #95, #96, #194, #106, #213, promotion); Ed to clear.
