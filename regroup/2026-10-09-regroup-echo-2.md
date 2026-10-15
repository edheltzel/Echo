# Regroup: Echo

Date: 2026-10-09
Sources: GitHub issues, PRs, tags and releases for edheltzel/Echo; `~/todo.txt` and `~/done.txt` (`+echo` tasks). Supersedes `2026-10-09-regroup-echo.md`, which said the tag came next and missed the todo.txt tasks.

## Last completed

- #221 merged into dev: version bump to 0.12.0 (2026-10-09).
- #222 merged into master (`082f05b`, 2026-10-09). It did not carry the release-ready dev: PR #223 still shows 55 changed files, including the `package.json` 0.12.0 bump.
- v0.11.0 tag and release backfilled on master `abdac2d` (2026-10-09).
- Closed 2026-10-09: #194, #191, #129, #106 as completed; #96 and #95 as not planned.
- todo.txt: newest done is ATL-632 and ATL-633, both Echo idea briefs (2026-10-04).

## Up next

- Merge PR #223 (dev to master, release v0.12.0) with a merge commit. Ed owns this merge.
- Then tag `v0.12.0` on that new master commit and publish the release with generated notes. Blocked on #223.
- todo.txt (A) ATL-456 "Echo #106 playback-state signal file" @review: #106 is closed and #218 merged, but the task line is still open.

## Remaining

- #8: npm install and update. Blocked on three decisions: package name, Bun required or bootstrapped, publish flow.
- #28: zero-touch docs. Blocked on #8.
- #17: OpenCode adapter. One check left: should a headless `opencode run` greet? Needs a live OpenCode session.
- #30: agent-agnostic epic. Not started.
- #126: meeting detection. Backlogged.
- #179, #180, #181, #195: explore-only ideas. Not started.
- todo.txt (B), all tagged @working since 2026-09-05:
  - `(B) 2026-09-05 ATL-352 Echo: finish Pi extension +echo @intern @working id:ATL-352`
  - `(B) 2026-09-05 ATL-353 Echo: ship thin Claude plugin (.claude-plugin) +echo @intern @working id:ATL-353`
  - `(B) 2026-09-05 ATL-356 RedTeam thin review of Echo Pi docs/prove +echo @intern @working id:ATL-356`
  - `(B) 2026-09-05 ATL-365 Echo: extension API for harnesses and features +echo @intern @working id:ATL-365`
