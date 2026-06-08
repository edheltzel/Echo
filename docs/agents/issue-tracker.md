# Issue tracker: GitHub + Local Markdown (hybrid)

This repo uses two surfaces:

- **GitHub Issues** — the canonical, shared tracker. Anything ready for an AFK agent or
  another person lives here. Use the `gh` CLI for all operations.
- **Local markdown** under `.scratch/<feature-slug>/` — a drafting scratchpad for breaking
  down work before it's ready to publish.

Default flow: draft locally, promote to GitHub when the issue is specified enough to act on.

## GitHub conventions

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line bodies).
- **Read**: `gh issue view <number> --comments`.
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with `--label` / `--state` filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

`gh` infers the repo from `git remote -v` when run inside the clone.

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

If given a GitHub issue number, run `gh issue view <number> --comments`. If given a local
path, read that file.
