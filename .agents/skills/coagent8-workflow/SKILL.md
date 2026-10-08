---
name: coagent8-workflow
description: Using CoAgent8 and developing its task orchestration, integrations and release gates.
---

# CoAgent8 workflow

## Use the tool

For a simple question use consult with a self-contained proposal. Do not read this
repository or run full diagnostics just to delegate arithmetic. Omit backend/model
for ordinary defaults; select them when the user names one or supplies a constraint.

doctor lists models, efforts, output prices and approval per backend from cached
data by default; scope health diagnoses sign-in and quota. A named model needs no
backend: auto runs it where its CLI lists it.
For a user's price limit pass output_price_below (USD per million output tokens,
strict) and omit model to let the server choose; see the README's
[model selection guidance](../../../README.md#choosing-a-model-under-a-price-limit).
On PRICE_LIMIT report the reason; never silently replace an explicit model.
Current execution is read-only.

Let the server obtain model consent from the user. On unsupported/unanswered
elicitation explain the model and reason. Do not set approval yourself or edit
neverAsk to make a blocked call run. A default config path may differ from the
running server's environment; do not change guessed config files.

## Work on the project

Read [HANDOFF.md](../../../docs/HANDOFF.md) for current state,
[ROADMAP.md](../../../docs/ROADMAP.md) for the single active plan and
[ARCHITECTURE.md](../../../docs/ARCHITECTURE.md) for current contracts and target
design. Read only the sections needed for the task. Optional docs/.local/
investigations are historical reference, never another plan.

The owner chose full agent orchestration on 2026-10-08. Roles and provider/model
choices are independent; writing, bounded delegation and client skills require
the roadmap's verified profiles/task contract. Do not remove current sandbox or
nested-turn enforcement as a shortcut.

Follow [core invariants](../../rules/00-core-invariants.md),
[security](../../rules/01-security-and-sandboxes.md),
[Git governance](../../rules/02-git-workflow.md) and the
[scope-based quality gate](../../rules/04-quality-gate.md).
Preserve the owner's local stack, existing changes, registrations and stored data.
Audit blockers come before exposing affected capabilities. Work remains local
unless the user authorizes integration/publication.

Prose needs content/link review and git diff --check, not runtime tests or paid
backend calls. Source comments/documentation tooling additionally need lint:docs
and docs; executable changes need their scope's behavioral checks. Keep source,
bundle, exact-artifact and native-host evidence distinct. A model READY string
does not establish independent checks or release approval.

Update the owning document in place: roadmap for remaining work/acceptance,
architecture for contracts/design, handoff for current evidence/next action.
README serves users. Remove superseded reports rather than append transcripts.
Keep required decisions in tracked documents; optional local notes may be ignored.
