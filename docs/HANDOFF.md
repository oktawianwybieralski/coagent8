# CoAgent8 handoff

Updated 2026-10-08. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities/acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Do not append another session transcript or treat old test counts as fresh evidence.

## Scope and decisions

The owner requested analysis of three agents' arithmetic trials and consolidation
around these three documents. The target is full MCP orchestration: complete tasks,
write/check/fix workflows, independent roles/models and installable client skills.
Current read-only profiles remain enforced until verified replacements land.
This task changes documentation and its reference wiring, not runtime behavior.

The starting checkout was clean on docs/coagent-direction at 1353fb9. Preserve
the local stack and owner-managed Git integration; no new checkout, reset, merge,
push or publication is part of this handoff. Inspect status again before editing.
Development ultimately targets release/v1.0.0 under the repository Git rules.

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

Start with AX-001/002: expose bounded prices with source/freshness/match quality,
then enforce an explicit output-unit-price constraint. Use the same selection
owner for future CLI and task calls. Success: an agent with only MCP tools can
choose a verified qualifying model in at most one discovery plus one execution,
without guessing, external price lookup or config modification.

Continue AX-003/004/005/006 for approval transport, effective config, readiness and
fresh-client acceptance. Keep existing consent fail-closed. Never silently replace
an explicit model or insert it into neverAsk. User limits and approval thresholds
are separate. A unit rate does not predict subscription charges or the total bill.

Design COAGENT-001/002 alongside these fixes, then implement one verified host-led
write/check/review path before enabling delegated coordinators. Preserve the
root-budget, writer ownership, interruption and evidence criteria in the roadmap.

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

Scope: documentation consolidation plus TypeDoc README reference. On Windows:

- PASS: content/source reconciliation and 73 local/repository links in the
  remaining tracked Markdown files, including heading anchors.
- PASS: owner decisions recorded in the pre-consolidation roadmap were
  reconciled into ARCHITECTURE's owner decisions table.
- PASS: git diff --check and npm run lint:docs.
- PASS: npm run docs, with warnings still treated as errors. The first run used
  ARCHITECTURE as the API landing page and failed on unsupported Mermaid code
  highlighting. Pointing the generator to the user README resolved that mismatch;
  diagrams remain in the repository architecture, and no check was disabled.
- NOT_RUN: runtime tests, build, consumer smoke and paid backend calls; this
  change has no runtime implementation and these checks are outside its scope.

No new independent release review, six-job CI or native acceptance is established.
The owner's earlier preliminary VSIX acceptance predates the shared-config change
1353fb9. Full native lifecycle and consent acceptance remain in ROADMAP.

## Compact handoff contract

For subsequent tasks supply: objective/role/profile, allowed scope and acceptance;
workspace/branch/target plus base/candidate or dirty-diff identity; changes;
checks with commands, platform, PASS/FAIL/NOT_RUN and evidence; unresolved work and
next action. Link to rules instead of copying them. A reviewer needs original
requirements and the actual candidate, not just an implementation summary.
