# AGENTS.md

## Purpose

`docs/` owns Echo's durable project knowledge: operating guides, design decisions, agent
workflows, implementation plans, and session handoffs that must remain available to future
contributors.

## Ownership

- `plans/` contains committed implementation plans. Current plans live at the directory root;
  completed or superseded plans retain their original filenames under `plans/archive/`.
  Durable evidence needed to execute a plan lives under `plans/support/<topic>/`.
- `handoffs/` contains committed session-continuity records. The current handoff lives at the
  directory root; retired handoffs retain their original filenames under `handoffs/archive/`.
- Other documentation areas keep the ownership described by the root documentation map.

## Local Contracts

- `docs/plans/` and `docs/handoffs/` are the canonical repository locations for plans and
  handoffs. Do not store canonical copies under `.agents/atlas/` or another agent-specific
  directory.
- Treat plans and handoffs as repository knowledge, not machine-local agent state: commit them,
  use repository-relative links, and exclude secrets, tokens, transient process details, and
  machine-only scratch data.
- `.agents/atlas/` may hold disposable local artifacts and worktrees only. Promote anything a
  future contributor needs into `docs/` and link it from the owning plan or handoff.
- Preserve historical content when archiving, but repair broken links and remove stale location
  mandates that conflict with the current DOX contract.
- Name handoffs `YYYY-MM-DD-HHMMSS-handoff-<slug>.md` and report the final repository path.

## Work Guidance

- Read the root `AGENTS.md` and `docs/dox.md` before editing documentation.
- Keep active material easy to discover at the directory root; move it to `archive/` once it no
  longer directs current work.
- When moving a plan, handoff, or supporting document, update every repository reference in the
  same change.

## Verification

- Search the repository for stale references to the previous location after moving documents.
- Run link or documentation checks when the repository provides them; otherwise inspect changed
  relative links and `git diff --check`.

## Child DOX Index

There are no child `AGENTS.md` files under `docs/`. Add one only when a documentation subtree
needs contracts more specific than this file.
