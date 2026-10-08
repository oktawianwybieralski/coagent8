# CoAgent8 handoff

Updated 2026-10-08. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities/acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Do not append another session transcript or treat old test counts as fresh evidence.

## Scope and decisions

The owner requested analysis of three agents' arithmetic trials and consolidation
around these three documents. The target is full MCP orchestration: complete tasks,
write/check/fix workflows, independent roles/models and installable client skills.
Current read-only profiles remain enforced until verified replacements land.
The latest task implemented AX-001/002 (per-model prices and the price limit) on
feat/ax-price-selection, branched from docs/coagent-direction at 3a9a4bb.

Preserve the local stack and owner-managed Git integration; no new checkout,
reset, merge, push or publication is part of this handoff. Inspect status again
before editing. Development ultimately targets release/v1.0.0 under the
repository Git rules.

## What the trials establish

| Evidence | Observation | Limit |
| --- | --- | --- |
| Codex, this conversation | doctor summary and full both omitted per-model prices. A separate public price lookup verified gpt-6-luna at USD 0.50 per million output tokens for the base tier; consult with codex/low returned 17 x 23 = 391 in 4.0 s. | Historical unit price, not request billing. Footer excludes preparation. Running server bundle identity was not verified. |
| Claude, owner-provided report | Selected luna/flash by name, reports two successful backend calls at 4.3 s and 12.2 s; noticed missing prices, agy readiness ambiguity and effort syntax. | No raw transcript/usage/phase trace here; not independently rerun. Price compliance was not established by governance. 4.3 s versus 12.2 s is not a controlled speed comparison: the footer excludes preparation and no phase trace attributes the difference to CLI startup. |
| Gemini, owner-provided report | Explicit model hit unanswered elicitation; fallback changed the requested model; first config edit targeted an inactive default path because an older registration set coagent8_CONFIG to VS Code storage. It attributed latency to full diagnostics, but both formats run the same probes. | Reported sequence, not independently rerun. No permission to edit the live config follows from this report. |
| Source inspection at 1353fb9 | DoctorPrices has source/fetchedAt/count only; both formats call runDoctor. Price parsing stores completion unit rates only. Governance checks approval thresholds, not a user ceiling. Config path can be overridden. | Static confirmation, not new behavioral/native acceptance. |

The successful Codex result still had excess discovery and repository-reading
overhead. Ordinary users should not need a source checkout, web price lookup or
full diagnostic dump. Claude could not use a public estimate that does not exist;
choosing by name and treating consent as cost compliance was the agent's mistake.
The product fix is executable selection metadata and constraints.

Source anchors:
- src/diagnostics/doctor.ts: DoctorPrices, runDoctor, formatDoctorSummary.
- src/tools/doctor.tool.ts: shared diagnostic work for summary/full.
- src/backends/prices.ts and governance.ts: unit-price storage and consent.
- src/tools/schema.ts and src/server.ts: caller-visible selection instructions.
- src/config.ts, config-overrides.ts and extensions/vscode/src/extension.ts:
  effective config and latest shared-default behavior.

## Next implementation

The owner requested dependency rules before source reorganization on 2026-10-08.
The P0 boundary rules and target architecture now have a local plan under
[SIMPLIFY-001](ROADMAP.md#simplify-001---module-boundary-migration). This change
is documentation only; source moves and automated dependency enforcement are
pending. Start with S0's fresh baseline because selection/doctor changes are
ongoing in this checkout. The migration does not change the release status or
the runtime evidence recorded below.

Rules/plan verification: source/content review and local Markdown link/anchor
checks passed; added text uses ASCII and git diff --check passed. Runtime tests,
builds and backend calls were not run for this prose-only change.

AX-001/002 landed locally (contract in
[ARCHITECTURE.md](ARCHITECTURE.md#price-limit)): output_price_below with strict,
consent-independent checks before consent and before session acquisition;
PRICE_LIMIT without substitution; auto choosing the qualifying default or the
highest-priced qualifying model. Owner decisions of 2026-10-08 set that rule and
the 5,500/3,900-byte budgets.

Stage 1 of the model registry followed the same day, verified first against the
installed CLIs without model turns (Claude Code 2.1.294 initialize lists 13 names
with concrete models; Codex model/list and account/rateLimits/read; agy 1.3.1
models lists Claude and GPT-OSS models too, so provider prefixes cannot route):
Claude catalog with aliases; model-based auto routing; Codex quota; per-model
stored prices (input, cached input, output) refreshed daily in the background;
doctor's cached model view as default and scope health; consent refusals that
do not advise another model.

Open: stage 2 measured usage per turn (tokens, list-price cost, subscription
window change for all three backends) and stage 3 pre-turn estimates and a
predictable plain consult (AX-001/002); concurrent root budgets (AX-002); the
fresh-client retest (AX-006).

Next: independent review of this branch, then AX-003/004/005/006 for approval
transport, effective config, readiness and fresh-client acceptance. Keep consent
fail-closed and never insert a model into neverAsk. Design COAGENT-001/002
alongside, then one verified host-led write/check/review path before delegated
coordinators, preserving the roadmap's root-budget, writer, interruption and
evidence criteria.

Open runtime limitations and the CUR items with local fixes are listed in
[ARCHITECTURE.md](ARCHITECTURE.md#known-limitations); do not reimplement fixed
items from an old snapshot report. Revalidate the candidate before claiming acceptance.

## Documentation disposition

Tracked project documentation is ROADMAP, ARCHITECTURE and HANDOFF. Runtime
contract and useful design material were consolidated; old plans, duplicate
handoffs/reports and docs/archive were removed. History remains in Git.

Optional ignored docs/.local/ preserves the pre-consolidation roadmap, detailed
audit, CLI proposal, integration/checklist, code-doc notes and provider/bundler
investigations. These snapshots are reference material, not current instructions;
their old relative links are not maintained. These eight snapshots match the
pre-consolidation HEAD after line-ending normalization and are recoverable from Git.
The pre-existing private competitor notes now live at docs/.local/competitors.md.
No version of those notes was found in reachable Git history; deleting that file
loses the local research unless backed up separately. Its historical product
claims are not current contracts. Required decisions, open work and acceptance
do not depend on local files.

README remains the quick start; extension README remains the editor guide.
Contributor rules retain safety/Git/verification authority. The workflow skill
now points directly to the three documents and includes a short usage path.

## Verification for this change

Scope: AX-001/002 and model-registry stage 1 (runtime, schema, TSDoc and docs),
on Windows 11, Node 26.10.0, source loaded through tsx:

- PASS: stage-0 verification against installed CLIs without a model turn:
  Claude Code 2.1.294 initialize (13 names with resolvedModel, 0.9 s, no result
  event), Codex app-server model/list and account/rateLimits/read (5h/weekly,
  0.7 s), agy 1.3.1 models. Read-only metadata calls, no paid backend call.
- PASS: npm run typecheck.
- PASS: focused tests via node tests/run.cjs, including price-limit (unit and
  controller), model-routing, Claude catalog and alias selection, Codex rate
  limits, per-model price storage/refresh, doctor model view and health scope,
  surface/budget, server and pipeline tests.
- PASS: full suite, node tests/run.cjs: 388 tests, 385 pass, 3 skipped, 0 fail.
  One earlier full run failed "storage locks serialize actual competing Node
  processes" once; it passed alone and in three later full runs. Unexplained,
  not attributed to this change.
- PASS: surface budgets: 5,459 of 5,500 tool-definition bytes, 507 of 512
  instruction characters.
- PASS: npm run lint:docs, npm run docs (warnings as errors) and git diff --check.
- NOT_RUN: build, consumer smoke and packaging (no bundle/package change claimed);
  dependency-cycle tooling (SIMPLIFY-001 is not implemented); paid backend calls
  and native fresh-client retests (AX-006).

No independent review, six-job CI or native acceptance is established for this
branch. Full native lifecycle and consent acceptance remain in ROADMAP.

## Compact handoff contract

For subsequent tasks supply: objective/role/profile, allowed scope and acceptance;
workspace/branch/target plus base/candidate or dirty-diff identity; changes;
checks with commands, platform, PASS/FAIL/NOT_RUN and evidence; unresolved work and
next action. Link to rules instead of copying them. A reviewer needs original
requirements and the actual candidate, not just an implementation summary.
