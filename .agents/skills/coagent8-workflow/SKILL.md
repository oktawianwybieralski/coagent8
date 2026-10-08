---
name: coagent8-workflow
description: Procedures for developing, testing, auditing, and releasing CoAgent8 MCP server.
---

# CoAgent8 workflow

Read [ROADMAP.md](../../../docs/ROADMAP.md) for the single active plan. Begin with
the highest-priority incomplete item relevant to the user's request; audit
blockers (`AUDIT-001`) come first. Current tool behavior is specified in
[RUNTIME_CONTRACT.md](../../../docs/RUNTIME_CONTRACT.md), including its known
deviations. Archival off is implemented through `coagent8_HISTORY=off`, while
session-free/per-call modes and persisted price catalogs are planned. Audit
findings and their reproductions are in the
[project review](../../../docs/PROJECT_REVIEW_2026-10-05.md).

The owner changed the product direction on 2026-10-08 to full task delegation,
configurable agent roles and client skill installation. Follow
[the coagent milestones](../../../docs/ROADMAP.md#full-coagent-direction);
model size and provider do not determine the coordinator or worker role.
Writing and delegated coordination remain planned until verified execution
profiles and task contracts are implemented. Do not replace current sandbox or
nested-turn enforcement with a prompt instruction or a blanket opt-out.

## Safety and contribution

Follow [core invariants](../../rules/00-core-invariants.md),
[read-only and consent rules](../../rules/01-security-and-sandboxes.md), and
[Git governance](../../rules/02-git-workflow.md). Use topic branches; never push
directly to main. Preserve unrelated edits, working registrations and stored data.
External diagnostic/review agents use read-only modes. Models the price policy
asks for run only after the user approves them in the client; agents cannot
grant that consent.

## Verification

[04-quality-gate.md](../../rules/04-quality-gate.md) is the authoritative local
verification policy. Classify the diff and run applicable checks once. Markdown
prose/planning changes require content/link review and git diff --check, not a
build, runtime suite, package smoke, generated API docs or backend AI invocation.
Do not run test processes just to modify README or record a plan.

Code, lifecycle, packaging and integration changes need relevant behavioral
checks. Portable selection, hermetic CLI fixtures and hidden Windows helper
launches are implemented; POSIX crash cleanup and native-host acceptance remain
open in the roadmap. Distinguish source-loaded tests, existing-dist setup checks
and fresh-artifact consumer evidence. Hide helper/descendant windows and retain
awaited owned-process cleanup.

Full release validation, the supported CI matrix and independent bound Reviewer
review remain required for release approval. Report actual results and limitations;
a model-generated envelope or an unchanged passing retry is not sufficient proof.

## Documentation

Update the existing roadmap with status and evidence; do not create a parallel
plan. README owns getting started, architecture owns current module boundaries,
the runtime contract owns behavior, and the integration guide owns optional host
setup. Historical review results are not fresh validation of the current tree. Current
approval/sandbox/cache findings are `CUR-*` in the snapshot review and runtime
contract. A READY envelope alone does not verify input completeness or release
hashes.
