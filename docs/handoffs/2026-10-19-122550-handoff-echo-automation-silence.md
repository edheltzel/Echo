# Handoff: health rate limit and automation silence

Date: 2026-10-19. Snapshot only. Do not start the next step from this file.

## State

- Merged into `origin/dev` on 2026-10-17 (tip `86910c7`): [#232](https://github.com/edheltzel/Echo/pull/232) retired config keys stay silent, `/health` reports `config.retired_keys`, doctor info row (`0bf1348`); [#233](https://github.com/edheltzel/Echo/pull/233) `cli/echo --help` backticks, doctor 429 reporting with an Echo-identity check, AGENTS.md no-mistakes `axi --yes` workflow (`86910c7`); [#234](https://github.com/edheltzel/Echo/pull/234) `todo.txt` / `done.txt` / `TODO.md` sync plus red-team corrections (`0aed0c3`).
- `origin/master` is still the v0.12.0 promotion (`2152491`, #230). Those three merges are on `dev` only.
- Open, waiting for Ed's merge. Both `mergeStateStatus` CLEAN as of this handoff:
  - [#235](https://github.com/edheltzel/Echo/pull/235) `fix/health-rate-limit` (`ef43807`): loopback `GET /health` exempt from the 10/60s notify bucket; non-loopback `/health` has its own bucket. X-Forwarded-For trust flagged, not changed. Live daemon listens on `*:3246`, not localhost; flagged against SECURITY.md.
  - [#236](https://github.com/edheltzel/Echo/pull/236) `feat/automation-silence` (`0279618`): `ECHO_AUTOMATION_ENV` is a comma-separated string, default `NO_MISTAKES_GATE`. It silences greeting, completion, and HIL for automation-launched agent sessions. Check is `isAutomationSession` in `shared/echo-env.ts`, called by `shared/notify-client.ts` and the Claude hooks. The AGENTS.md invariant is on that branch at line 227 (not in the current checkout until #236 merges). Research: [.scratch/nm-exclusion/research.md](../../.scratch/nm-exclusion/research.md).
- `gh pr list --state open` showed only #235 and #236.
- Machine-local: daemon payload is `~/Library/Application Support/echo/payload/versions/0.12.0` (`readlink` of `payload/current`). Needs `cli/echo update` after #235 and #236 merge. `~/Library/Logs/echo.log` is gone from Logs; the daemon (pid holding `payload/current/core/server.ts`) still has stdout/stderr open on `~/.Trash/echo.log`. `ls` of that Trash path failed from this session; `lsof` still names it. `bun run restart` restores a normal log. Homebrew `but-axi` is absent (`/opt/homebrew/bin/but-axi` missing, not on PATH). Use `node ~/Developer/ButAxi/dist/bin/but-axi.js`.

## Decisions

- Ed: auto-merge low-risk (docs/tests-only) PRs once CI is green and current. Recall learning #1352. Also in [AGENTS.md](../../AGENTS.md) Release and versioning.
- Ed: run no-mistakes autonomously with `axi run --yes` from the plain clone `~/Developer/Atlas/Echo-nm` (machine-local), not for dev-to-master promotions. Recall #1351.
- Ed: silence everything for automation sessions. Plain `claude -p` outside automation is intentionally not silenced (mine, deferred).
- Config value is a string because config only accepts primitives.

## Open questions

- Promotion validation decision: todo.txt `@waiting` line on #230 (NM cancelled because the pipeline rebases and breaks the merge commit).
- #8 npm package decisions.
- Whether to silence plain `claude -p`.
- Whether the `/health` limiter should stop trusting X-Forwarded-For, and whether the daemon should bind localhost only versus the live `*:3246` bind (SECURITY.md).

## Next step

Ed merges #235 and #236, then `cli/echo update` and `bun run restart`, then verify an `omp -p` / no-mistakes run stays silent.

## Links

- [#235](https://github.com/edheltzel/Echo/pull/235): health rate-limit isolation. Head `ef43807`.
- [#236](https://github.com/edheltzel/Echo/pull/236): automation silence. Head `0279618`. Invariant on that branch: `AGENTS.md:227`.
- [.scratch/nm-exclusion/research.md](../../.scratch/nm-exclusion/research.md): why the exclusion is an env marker, not a host name.
- [docs/configuration.md](../configuration.md): `ECHO_AUTOMATION_ENV` (lands with #236).
- [docs/http-api.md](../http-api.md): rate limits.
- [regroup/2026-10-15-regroup-echo.md](../../regroup/2026-10-15-regroup-echo.md): prior status snapshot.
- [docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md](2026-10-14-205500-handoff-echo-scripts-release-voice.md): previous handoff (scripts, v0.12.0, voice options).

## todo.txt

- Merge #235 and #236, then cli/echo update and bun run restart
- Decide whether the /health limiter should stop trusting X-Forwarded-For and whether the daemon should bind localhost only
- Decide whether to silence plain claude -p sessions outside automation
