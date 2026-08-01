# Triage Labels

Echo's issue labels follow the namespaced taxonomy shared with [Recall](https://github.com/edheltzel/Recall), so the two repos speak the same vocabulary. Namespaces group by axis: what the work *is* (`type:`), who or what should pick it up (`agent:`, `needs:`), how much judgement it demands (`risk:`), and why it is parked (`blocked:`).

An issue normally carries **one** `type:`, and — once triaged — one `agent:` and one `risk:`.

## `type:` — what the work is

| Label | Meaning |
| --- | --- |
| `type:bug` | Something isn't working |
| `type:feature` | New feature or request |
| `type:docs` | Improvements or additions to documentation |
| `type:test` | Test coverage or test infrastructure |
| `type:refactor` | Restructuring without behavior change |
| `type:chore` | misc things, like cleanup |

## `agent:` — autonomous-agent readiness

| Label | Meaning |
| --- | --- |
| `agent:ready` | Fully specified, ready for an AFK agent |
| `agent:blocked` | An agent picked this up and cannot proceed |
| `agent:complete` | Agent work finished, awaiting validation |

`agent:complete` is not the same as closed. It means the work is claimed done and is waiting on a human or an adversarial validation pass. Close only after the claim is verified.

## `needs:` and triage state

| Label | Meaning |
| --- | --- |
| `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | Waiting on reporter for more information |
| `needs:human` | Requires human implementation |

`needs:human` and `agent:ready` are mutually exclusive — an issue is one or the other.

> Naming wart, inherited from Recall and kept deliberately so both repos match: `needs-triage` and `needs-info` use a hyphen while `needs:human` uses a colon. Fix it in Recall first if you want it fixed, then mirror the change here.

## `risk:` — judgement and blast radius

| Label | Meaning |
| --- | --- |
| `risk:low` | work that is non-ambiguous, no human judgement as `agent:ready` |
| `risk:medium` | Some judgement required; review the result carefully |
| `risk:high` | Significant judgement or blast radius; human oversight expected |

## `blocked:` and terminal states

| Label | Meaning |
| --- | --- |
| `blocked:on-evidence` | Parked pending real-world evidence; not blocked on a human decision |
| `wontfix` | Will not be actioned |

`blocked:on-evidence` is the honest label for "we cannot decide this until we have seen it happen for real." It is distinct from `needs-info`, which is blocked on a *person* answering.

## Echo-specific labels

These have no Recall equivalent and describe Echo's own architecture concerns. They compose with the taxonomy above rather than replacing it.

| Label | Meaning |
| --- | --- |
| `architecture` | Foundational structure and design changes |
| `decoupling` | Separating concerns, removing tight coupling |
| `packaging` | Release, distribution, and package management |
| `agent-friendly` | Optimized for autonomous AI agent consumption |

## Legacy labels

`bug`, `enhancement`, and `documentation` predate this taxonomy and still sit on issues filed before it existed. They map to `type:bug`, `type:feature`, and `type:docs`. Existing issues were **not** bulk-relabeled; new issues use the namespaced vocabulary. Retire a legacy label from an issue when you next touch that issue for another reason.

The remaining GitHub defaults (`duplicate`, `good first issue`, `help wanted`, `invalid`, `question`) are unused in practice.

## When a skill names a role

Skills speak in terms of triage roles rather than exact label strings. Map them here:

| Role a skill mentions | Label to apply |
| --- | --- |
| AFK-ready / ready for an agent | `agent:ready` |
| Needs a human | `needs:human` |
| Untriaged | `needs-triage` |
| Awaiting the reporter | `needs-info` |
| Will not be actioned | `wontfix` |
