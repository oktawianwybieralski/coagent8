# P1: CoAgent8 review envelope and release binding

CoAgent8 project rule. It adds requirements to
[core rule 03](core/03-review.md) (separation, review input, severity and the
PR evidence line) and never relaxes one. The required reviewers are named in
[`.agents/project.md`](../project.md#reviewers).

## Roles

Roles are independent of model size and provider (owner decision 2026-10-08).
A planner may review a worker's implementation, but evaluates the original
requirements as well as their plan. The
[full coagent plan](../../docs/ROADMAP.md#full-coagent-direction) defines
configurable product roles without relaxing independent review gates.

## Review input in this project

Beyond core rule 03, the requirements in `instructions` include the acceptance
text of every roadmap card and queue row the change closes and the dated
[ARCHITECTURE](../../docs/ARCHITECTURE.md) decisions it implements. Changed
documentation to check includes HANDOFF, ROADMAP, README, skills and TSDoc.

## State envelope

Independent review runs the CoAgent8 `review` tool in its read-only profile. A
plain `consult` is advisory: it requests no envelope and never substitutes for
review or for bound release approval. The reviewer answers with:

```text
REVIEW: <turn>
SNAPSHOT: <sha>
COVERAGE: COMPLETE | PARTIAL
VERDICT: READY | BLOCKED

[P1/P2/P3] <file>:<line>
Problem: <concise statement>
Evidence: <reproducible detail>
Fix: <actionable remedy>

CHECKS: typecheck=<PASS|FAIL|NOT_RUN>; tests=<PASS|FAIL|NOT_RUN>
END_REVIEW
```

The reviewer ends with `CHECKS`; CoAgent8 appends `END_REVIEW` after it has
verified that the turn completed (`ENVELOPE-001`). The runtime gate blocks
incomplete input, a wrong snapshot, a changed workspace and failed CHECKS
(`CUR-001`). It validates reported outcomes but does not prove a model's PASS
claim or bind a release artifact. A read-only reviewer cannot run checks: its
NOT_RUN does not block, the server verdict names them (`READY (typecheck and
tests not run)`), and the author runs them locally and CI runs them on the PR
(owner decision 2026-10-11). Ordinary documentation edits do not need a backend
AI call or runtime tests merely to fill an envelope.

## Release candidate binding

For releases and release candidates the review covers the complete committed
release diff against its accepted base (`<base_sha>..<candidate_sha>`), and the
approval records and binds to:

- the base commit SHA,
- the candidate commit SHA,
- the exact tree SHA,
- the package tarball SHA-256.

A review of uncommitted changes is advisory until bound to that committed
snapshot. Any change to the candidate invalidates the approval and requires a
fresh review turn.
