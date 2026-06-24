# Design Documents

Catalogue of design docs for atlas-voicesystem. Each captures the rationale behind a
non-obvious decision so agents (and humans) can recover the *why*, not just the *what*. See
[`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) for the current codemap.

| Document | Status | Last Updated | Summary |
|---|---|---|---|
| [pi-completion-injection.md](pi-completion-injection.md) | Shipped | 2026-06-23 | Pi speaks per-turn completions by injecting the `🗣️` convention into Pi's system prompt via `before_agent_start` (issue #15). |

Status values: `Draft`, `In Review`, `Approved`, `Shipped`, `Superseded`, `Deprecated`.

When a design decision is made, add a doc here and a row to this table. Keep the table the
fast scan; keep the detail in the linked doc.
