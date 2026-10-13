# Regroup: Echo

Date: 2026-10-09
Sources: repo-root `todo.txt` (no sibling `done.txt`); `~/todo.txt` and `~/done.txt` `+echo` lines; GitHub issues, PRs, tags and releases for edheltzel/Echo. Previous file: `2026-10-09-regroup-echo-2.md`.

## Brief review: ATL-632 and ATL-633

- The brief work itself is done: `x 2026-10-04 2026-10-04 ATL-632 Echo: Grok speech provider idea brief` and `x 2026-10-04 2026-10-04 ATL-633 Echo: daemon-owned notification idea brief` (`~/done.txt:226-227`).
- No brief file for either exists in the repo, and the source does not say where the briefs were written.
- ATL-632 follow-up is still open: `2026-10-09 ATL-632 Grok as a speech provider (xAI TTS). ... Check BigMac for local or uncommitted work +echo @check atl:632`. Not started: no code, no issue.
- ATL-633 follow-up is still open: `2026-10-09 ATL-633 Daemon-owned notice (no name yet). Blocked until Ed names the mechanism ... +echo @outstanding atl:633`. Blocked on Ed naming the mechanism.

## Last completed

- 2026-10-09: v0.12.0 tagged on master `7b79250` and released (Latest), after #223 merged with a merge commit.
- 2026-10-09: #226 deleted the shipped notification-sounds and banner-isolation plans.
- 2026-10-09: #129, #106, #191, #194 closed as completed; #95, #96 closed as not planned.

## Up next

- `(A) 2026-09-10 ATL-456 Echo #106 playback-state signal file +echo @intern @review id:ATL-456`: #106 shipped in #218 and is in v0.12.0, so this line is ready for Ed to mark done.
- Local daemon still runs 0.11.0; `cli/echo update` picks up v0.12.0. Not in the todo source; from the release state.

## Remaining

Repo `todo.txt` lines whose GitHub item has since closed or merged (stale; Ed to clear): promote dev to master; #129; #191; #95; #96; #194; #106 (@check); #213 (@inprogress, merged).

Still open:
- ATL-633 daemon-owned notice: blocked on Ed naming the mechanism.
- ATL-632 Grok/xAI TTS: not started; check BigMac for local work.
- Tern button to toggle mute and sound modes: not started; Tern SDK research, no brief.
- OpenCode HIL announce (`permission.asked`): not started; no issue.
- Auto-quiet during desktop voice conversations: blocked on two research questions (who holds the mic; how desktop-app events reach Echo).
- #17 OpenCode adapter: headless `opencode run` greeting check left; needs a live session.
- #30 agent-agnostic epic: closes with #17.
- #8 npm install/update: blocked on package name, Bun bootstrap, publish flow.
- #28 zero-touch docs: blocked on #8.
- #126 meeting detection: backlogged.
- #179, #180, #181, #195: backlogged ideas.
- @check: 8 baseline local test failures (no issue); `docs/regroup-2026-10-07` branch never merged; what the BigMac daemon runs.
- @close candidates: FM-352/356, FM-353 (merged #176), FM-365 (merged #177), merged remote branches to prune after Ed confirms. `~/todo.txt` still lists ATL-352, ATL-353, ATL-356, ATL-365 as `(B) ... @working`.
