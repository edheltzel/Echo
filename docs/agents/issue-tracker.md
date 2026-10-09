# Issue tracker: GitHub + Local Markdown (hybrid)

This repo uses two surfaces:

- **GitHub Issues** - the canonical, shared tracker. Anything ready for an AFK agent or
  another person lives here. Use `gh-axi` (agent-optimized wrapper over `gh`) for issue and
  PR operations; fall back to raw `gh` only for what `gh-axi` does not wrap.
- **Local markdown** under `.scratch/<feature-slug>/` - a drafting scratchpad for breaking
  down work before it's ready to publish.

Default flow: draft locally, promote to GitHub when the issue is specified enough to act on.

## GitHub conventions

Run the installed binary (`gh-axi`, from Homebrew), never `npx gh-axi`: this repo is Bun
only (AGENTS.md). `gh-axi <command> --help` is the current flag reference.

- **Create**: `gh-axi issue create --title "..." --body-file <path>`
- **Read**: `gh-axi issue view <number> --comments` (`--full` for untruncated bodies)
- **List**: `gh-axi issue list --state open` with `--label` / `--state` / `--fields` filters
- **Comment**: `gh-axi issue comment <number> --body "..."`
- **Labels**: `gh-axi issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh-axi issue close <number> --reason completed|not_planned --comment "..."`
- **PRs**: `gh-axi pr view|create|merge ...`

Both tools infer the repo from `git remote -v` when run inside the clone. Issues only
auto-close from `Closes #N` when a PR merges into the default branch (`master`); a PR into
`dev` needs the issue closed by hand with a comment naming the PR.

## Local markdown conventions

- One feature per directory: `.scratch/<feature-slug>/`
- PRD: `.scratch/<feature-slug>/PRD.md`
- Issues: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state: a `Status:` line near the top of each file (see `triage-labels.md`)
- Conversation history appends under a `## Comments` heading at the bottom

## When a skill says "publish to the issue tracker"

If the work is still being drafted, create/update the local markdown file. Once it's
specified enough to be picked up by a human or AFK agent, create a GitHub issue (and
reference the local draft if one exists).

## When a skill says "fetch the relevant ticket"

If given a GitHub issue number, run `gh-axi issue view <number> --comments`. If given a local
path, read that file.
