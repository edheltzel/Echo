# Plan — Agent-First Repo Cleanup & Legibility

- **Date:** 2026-06-24 · **Owner:** Themis (PM) → Ed for approval/merges
- **Basis:** `~/Developer/atlas-skills/agent-first-repo/` (knowledge hierarchy, 3 pillars: legibility, progressive disclosure, mechanical enforcement; entropy management)
- **Principle applied:** the skill says *"not every project needs all of this — start with AGENTS.md + ARCHITECTURE.md and grow."* This repo is a small, single-context Bun daemon + 2 adapters, freshly at v0.1.0. So this plan is **right-sized, not the full hierarchy** (no exec-plans/, product-specs/, RELIABILITY.md, FRONTEND.md, generated/ — those would be over-building).

## Gap analysis (current → agent-first)
| Area | Now | Target |
|---|---|---|
| Entry point | `AGENTS.md` 351 lines (everything inline) | Lean ~100-line `AGENTS.md` (commands, repo map, pointers) + progressive disclosure |
| Architecture | none | `ARCHITECTURE.md` — codemap, boundaries, invariants |
| Security | scattered in AGENTS.md | `SECURITY.md` — the model is well-defined (localhost-only, CORS, rate-limit, egress gating, no secrets) |
| Docs tree | flat `docs/` | `docs/design-docs/index.md` + relocate real design docs |
| Mechanical enforcement | 1 structural test | Promote top `core/` invariants to failing-CI checks |
| Cruft | 16 scratch files in `.agents/atlas/artifacts/`, root `SCOUT-REPORT.md`, stray `docs/plans/` | Archived/removed; design docs relocated |

## Proposed phases (each: worker → reviewer sign-off → **Ed merges**)

### Phase 1 — Scout + ARCHITECTURE.md (Explorer/worker, codegraph-grounded)
- Author `ARCHITECTURE.md`: bird's-eye codemap (`core/` universal daemon, `adapters/pai`, `adapters/pi`, `scripts/`, compat path), the boundaries (`core/` is host-neutral — no host imports), cross-cutting concerns (voice resolution, circuit breaker, egress, drop-off log), and the invariant list.
- Inventory the **top architectural invariants** worth mechanical enforcement.

### Phase 2 — Trim AGENTS.md + docs progressive disclosure
- Reduce `AGENTS.md` to a lean entry point: quick commands, repo map, the hard invariants (must-not-do), and **pointers** into `docs/` + `ARCHITECTURE.md`. Keep the DOX rail.
- Move the detailed sections (HTTP API, egress gating, drop-off log, circuit breaker, voices, per-turn voice, adapter rules, PAI compat) into focused `docs/` pages; add `docs/design-docs/index.md`.

### Phase 3 — Mechanical enforcement (the highest-leverage pillar)
Promote prose invariants to **tests/lints that fail CI** (extend the `server-contract-source.test.ts` pattern or a small lint script in `.githooks`/`tests`):
- `core/` imports no host APIs (PAI/Pi/Claude/OpenCode) — structural test.
- No `:31337` references; no `/tmp` process-state paths; no new PAI-named endpoints.
- (Confirm exact set in Phase 1.)

### Phase 4 — SECURITY.md + cleanup
- `SECURITY.md`: trust boundary (localhost), CORS/rate-limit, egress posture, secret handling.
- Cleanup: delete consumed worker/explorer/reviewer briefs in `.agents/atlas/artifacts/`; relocate real design docs (`15-pi-hooks-design.md`, the architecture-guide) to `docs/design-docs/`; assess/relocate root `SCOUT-REPORT.md`; keep implementation plans under `docs/plans/` and archive completed plans there.

## Optional (only if you want it) — Phase 5
- `QUALITY_SCORE.md` (grade each domain/layer) + a short golden-principles/entropy doc + a recurring cleanup note. Useful long-term, but optional for a repo this size.

## Explicitly NOT doing (anti-over-build)
- No exec-plans/, product-specs/, generated/, RELIABILITY.md, FRONTEND.md, DESIGN.md.
- No rewrite of working code; enforcement only encodes existing invariants.

## Verification
- `bun test` green after each phase; new enforcement tests actually fail when an invariant is violated (prove them).
- AGENTS.md still passes its own DOX contract; no broken doc cross-links.
