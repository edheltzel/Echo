# Handoff: Echo package scripts, v0.12.0, local voice options

Date: 2026-10-14. Status snapshot: [regroup/2026-10-14-regroup-echo.md](../../regroup/2026-10-14-regroup-echo.md).

## State

- dev `0d93361` contains #228: root `package.json` scripts wrapping `cli/echo` and the test scripts. Verified under npm, pnpm, bun and vp; `smoke` and `e2e` exit 0 in each.
- master is `7b79250`, tagged v0.12.0. #226-#228 are on dev only.
- Local daemon (machine-local): `com.echo` runs `~/Library/Application Support/echo/payload/versions/0.12.0`, healthy. `/health` flags `ECHO_VOICE_SAY_NAME` in `~/.config/echo/config.json` as ignored; that is expected, because v0.12.0 retired the key. Left in place.
- edge-tts (machine-local): installed into Homebrew Python 3.15. It will break again on the next Homebrew Python upgrade.
- Plain clone (machine-local): `~/Developer/Atlas/Echo-nm`, with No Mistakes initialized; used to run the gate outside GitButler.
- `bun test` has 6 failures on this machine (Claude plugin validate, runEchoMute, omp HIL, two Pi lifecycle tests, one integration test). They were not compared against a clean dev run.

## Decisions

- Ed: `npm run <x>` must work, alongside pnpm, bun and vp. The repo itself stays Bun-only.
- Mine: the install alias is `install:echo`, not `install`, so it never shadows the package manager's install. `restart` uses `launchctl kickstart`, not `scripts/restart.sh`. The `--` flag rules per runner are documented in `AGENTS.md:31-38`.
- Ed: run No Mistakes autonomously with `no-mistakes axi run --yes`. Saved as Recall learning #1351. It is not yet in AGENTS.md.
- Ed: Supertonic is rejected (archived). Pocket TTS is preferred for a local voice over Kitten (KittenTTS 2 is 1.7B parameters).
- Ed: OpenAI and xAI voices need API keys and separate billing; not pursued yet.

## Open questions

- Add a `no-mistakes axi run --yes` workflow line to root `AGENTS.md`? DOX says durable behavior changes belong there.
- Keep or trash the clone `~/Developer/Atlas/Echo-nm`?
- Fix the `cli/echo doctor` 429 misreport and the `--help` backtick bug?

## Next step

Open the dev to master promotion PR (merge commit) for #226-#228, and validate it with `no-mistakes axi run --yes` from `~/Developer/Atlas/Echo-nm`.

## Links

- `package.json`: the scripts block.
- `AGENTS.md:31-38`: script aliases and per-runner flag forwarding.
- `docs/operations.md`: Restart section, rewritten by the No Mistakes document step.
- `tests/e2e-converse.sh`: health probe header and 15-second deadline (No Mistakes fix).
- PR #228: the No Mistakes run summary is in the PR comments and body.
- `regroup/2026-10-14-regroup-echo.md`: full open-item list.

## todo.txt

- Promote dev to master for #226-#228 (merge commit), validated with No Mistakes `--yes`
- Add a no-mistakes axi `--yes` workflow line to AGENTS.md
- Fix `cli/echo doctor` reporting a /health 429 as a foreign port owner
- Fix `cli/echo --help` backticks being evaluated by the shell
- Trial Pocket TTS through the Kokoro endpoint on an isolated daemon
