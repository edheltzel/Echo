# First-run UX pass

## Outcome
A newcomer reaches "Hello from Echo" without jargon, dead steps, or a silent fallback, and the landing page, docs sidebar, and CLI help point the same way.

## Implementation Units
### U1. README fast path
- Depends on: none
- Files: README.md
- Change: install + hear-it steps move under the tagline; steps 2 and 3 each carry their own content; an npx vs cli/echo note; a "wire your agent" table; comparison table, feature matrix, mermaid and the "I want to..." table move below.
- Done when: the first command is on screen one and no step is an empty heading.
- Verify: `cd site && npm run build` (anchors resolve) and a read-through of the first 80 lines.

### U2. Tutorial first-run traps
- Depends on: none
- Files: docs/getting-started.md
- Change: edge-tts prerequisite with the brew fix; a doctor step; voice-resolution detail moves into a symptom/cause/fix table; "Themis" becomes a neutral persona listed from `GET /voices`; uninstall section; one recommended next step; a one-line glossary.
- Done when: a reader with only Node and Bun knows edge-tts is required before the first sound, and the tutorial ends with uninstall and one next action.
- Verify: read-through against the shipped behavior in docs/what-echo-does.md and docs/voices.md.

### U3. Host chooser
- Depends on: U1
- Files: docs/install-human.md
- Change: host, command, what-you-get table at the top, before the long bullet list.
- Done when: every adapter id in the table matches the CLI help host list.
- Verify: `cli/echo --help` host list matches the table rows.

### U4. Landing and sidebar
- Depends on: none
- Files: site/src/pages/index.astro, site/src/site.ts, site/src/docs.ts
- Change: drop the repeated headline; demote the GAP row out of the hero; show macOS + Bun next to the install command; supported-hosts strip and a sample spoken line; plainer sidebar labels; primary CTA to the tutorial.
- Done when: the hero has one primary command and the sidebar labels read in plain words.
- Verify: `cd site && npm run build`, then view at 340px and desktop, dark and light.

### U5. CLI help
- Depends on: none
- Files: cli/echo
- Change: help text only. A "Start here" block, an npx note, and grouped sections (Set up, Every day, maintenance). No behavior change.
- Done when: `cli/echo --help` shows the new structure and every existing command still appears.
- Verify: `bun test tests/scripts/echo-cli.test.ts`.

### U6. DOX upkeep
- Depends on: U2, U4
- Files: docs/AGENTS.md, site/AGENTS.md
- Change: update the owning contracts only if the edits changed what they promise.
- Done when: both contracts still match the tree, or are updated to.
- Verify: read docs/AGENTS.md and site/AGENTS.md against the diff.

## Out of scope
Behavior changes to the daemon, adapters, or install scripts. Committing. The unrelated dirty files in the tree (todo.txt, package.json, bun.lock, docs/plans/2026-11-17-echomeet-meeting-auto-mute-plan.md, regroup/).

## todo.txt
- Visual check of the landing page at phone width and desktop, dark and light, once the site dev server is up

Review complete
