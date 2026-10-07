# Current handoff - documentation reconciled on 2026-10-07

~~~yaml
task_id: DOCS-001
mode: documentation
topic_branch: docs/audit-reconciliation
target_branch: release/v1.0.0
implementation_sha: 24052e3fc99de404cfb81c24f58e302c90a29cd8
accepted_release_candidate: null
documentation_candidate: docs/audit-reconciliation
release_approval: not_granted
~~~

The owner confirmed the reworded security rule 01 (P0) on 2026-10-07: consent
precedes session acquisition and any model turn, metadata probes may start CLIs
before it, and only an explicit `approve: true` is consent.

[ROADMAP.md](ROADMAP.md#current-snapshot-status) is the single active plan.
[RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) describes the source snapshot;
[the review](PROJECT_REVIEW_2026-10-05.md#review-at-24052e3-2026-10-07)
records newer findings and test provenance. The previous detailed branch ledger
is preserved as [historical evidence](archive/HANDOFF_STACK_2026-10-07.md).

## Current state

Local stacked changes implement owned-process cleanup, separate answer redaction,
bounded best-effort archives, typed errors, workspace isolation, cached probes,
six tools, Markdown execution results, model catalogs and user elicitation.
Plugin/VSIX payloads are assembled from the npm tarball. The stack is not a
merged, matrix-verified or released candidate. Package metadata is beta.1.

New open findings concern incomplete review input/approval binding, inherited
Codex/agy MCP capabilities, automatic-routing cache
failures, sticky commentary limits, concurrent cache misses and request-budget
scope. The runtime contract lists these as `CUR-001` through `CUR-012` (the last is source-inspected capacity accounting).
`CUR-003` (accepted consent without the checkbox) is closed on `fix/explicit-consent`.

Archival off does not mean session-free execution. Catalog validation is
best-effort. Current consent uses model-name families; relative-price consent
is a proposal. Model catalogs and defaults come from the CLIs and `config.json`
(`refactor/model-catalog-cache`). Do not document them as existing
configuration or weaken the P0 policy while implementing them.

## Local branches after 24052e3

Stacked in this order on `docs/model-governance-plan` (`24052e3`); nothing is
pushed. The ledger up to `24052e3` is in the
[archived handoff](archive/HANDOFF_STACK_2026-10-07.md).

| Branch | Commit | Content |
| --- | --- | --- |
| `docs/audit-reconciliation` | `5d0c9f5` | Documentation reconciled with the review at `24052e3` (`CUR-001` to `CUR-012`); rule 01 wording confirmed by the owner |
| `fix/explicit-consent` | `d811099` | `CUR-003`: only an accepted form with `approve: true` is consent |
| `fix/session-effort-continuation` | `690b3d0` | A continuation keeps the session's reasoning effort (found by the headless AX retest) |
| `docs/ax-retest` | `dd4711a` | Headless AX retest in fresh Codex and agy sessions recorded in `CONTEXT-001` |
| `refactor/model-catalog-cache` | this change | No model names in `src/` code (governance aside); defaults from the CLIs and `config.json`; catalogs in `models.json`; Claude names resolved through `system/init` |

## Next work

Order decided by the owner on 2026-10-07: `CUR-003` first (done), then:

1. Done: `refactor/model-catalog-cache` (`EXEC-001`). The recorded Claude
   default is `claude-opus-5-5` on the owner's account, governed by the current
   name rule, so headless clients must name a Claude model until step 2.
2. `feat/price-based-consent` (`EXEC-001`); the owner confirms the new rule 01
   text before it is committed.
3. Close `CUR-001` (review input completeness/snapshot binding) and `CUR-002`
   (inherited MCP isolation), then the execution/cache/session work in the
   owning roadmap milestones.
4. The owner retests in VS Code chat hosts after restarting them; rebuilding
   does not reload a running server process or tool catalog. Interactive
   consent and native/UI acceptance remain separate from headless measurements.
5. Integrate the stack through the required PR/review workflow; validate the
   exact candidate on all six CI jobs before tester publication. The roadmap
   owns beta gates, release artifacts and the owner's npm-placeholder deadline.

The headless AX retest in fresh Codex and agy sessions ran on 2026-10-07 and is
recorded in `CONTEXT-001`; its one CoAgent8 defect is fixed on
`fix/session-effort-continuation`.

## Verification and invariants

Use the [quality gate](../.agents/rules/04-quality-gate.md). Markdown changes need
content/link review and `git diff --check`. Source-comment changes additionally
need `npm run lint:docs` and `npm run docs`. Two executable parameter descriptions
were corrected in this task; run typecheck and the focused surface/budget suite.
No routing, model-validation or consent logic changed.

The preceding runtime review ran 266 tests (263 pass, zero fail, three skips),
then a fresh build and fixture-backed consumer smoke. Source unit/e2e evidence,
pre-existing-dist setup evidence and fresh-tarball evidence are distinguished in
the review. Those are historical results, not validation of this documentation
candidate. Validation of this documentation candidate: typecheck, documentation lint/API
generation, 15 source surface tests and local link/diff checks pass. The API gate
initially caught three private types in exported signatures and a private-constant
link; type-only exports/link repair resolved them without disabling warnings.
No full runtime suite, dist build or consumer smoke was rerun for this task.

Follow [core invariants](../.agents/rules/00-core-invariants.md),
[security](../.agents/rules/01-security-and-sandboxes.md) and
[Git governance](../.agents/rules/02-git-workflow.md).
Do not hand-edit CHANGELOG, push to main, modify working host registrations,
sweep a live desktop, or infer release approval from a model-written envelope.
For release review bind base, candidate, tree and artifact SHA-256. For a dirty
review capture the diff digest and untracked inventory; HEAD alone is insufficient.

## Windows working notes

Use PowerShell or Node spawn for `/usage` probes; Git Bash can rewrite a leading
slash into a Windows path. Hide independently launched descendants and await
owned cleanup. Use exact file writes/replacement functions for Markdown and
literal dollar signs. Keep failure logs and report unexecuted checks as NOT_RUN.
