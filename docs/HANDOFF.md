# Current handoff - documentation reconciled on 2026-10-07

## Next step: prepare the beta.2 candidate locally

The [CLI setup handoff](CLI_SETUP_HANDOFF.md) is complete for its scope: the
owner accepted VSIX installation and uninstallation on Windows (see the owner
acceptance in `INSTALL-001` of the [roadmap](ROADMAP.md)). The owner handles Git
cleanup, pushing, releases and any npm publication personally; agents prepare
the candidate locally. The roadmap remains the single active plan; this section
is a copyable prompt, not a second plan.

~~~text
You continue CoAgent8, a client-independent MCP-to-CLI bridge. Goal: close the
remaining beta.2 blockers and prepare the candidate locally. Work in the main
checkout C:\Users\Oktawian\Home\oki.dev\coagent8 on branch fix/vsix-presentation,
starting at the commit that added this prompt to docs/HANDOFF.md.

Read first: AGENTS.md and every rule in .agents/rules/, docs/ROADMAP.md
(AUDIT-001 and BETA-001), docs/RUNTIME_CONTRACT.md section 7 and
docs/PROJECT_REVIEW_2026-10-05.md (review at 24052e3).

Working rules from the owner:
- Local work only. Do not push, open pull requests, merge, tag, create releases
  or publish anything (no npm). The owner does Git cleanup, integration and
  publication personally; do not plan or suggest those steps.
- Never create a git worktree or a parallel checkout. Other agents may edit this
  checkout: run git status first, keep unrelated changes, and ask the owner
  before switching or creating branches. Commit finished steps on the current
  branch with Conventional Commit messages and no AI attribution.
- Repository artifacts in English and ASCII only; talk to the owner in Polish.
- Choose checks with .agents/rules/04-quality-gate.md. Give the owner the exact
  path and SHA-256 of any artifact to install. Never run a model turn that the
  consent policy would ask for without the owner's approval.
- Do not lower a gate. If a blocker cannot be closed, stop and describe the
  options for an owner decision.

Open blockers: CUR-002 (inherited MCP isolation for Codex and agy, P0 safety),
CUR-001 and CUR-013 (review completeness and snapshot binding). Done and
owner-accepted: VS Code onboarding, agy discovery from ~/.gemini/bin, silent
agy sign-in detection, install/uninstall/cleanup.

Work in this order; update the roadmap with evidence after each step and report
PASS/FAIL/NOT_RUN with the commands you ran:

1. CUR-002. Prove or enforce that a CoAgent8 turn cannot use MCP servers or
   plugins inherited from the user's Codex or agy configuration, including a
   recursive CoAgent8 registration. Codex: find a supported app-server override
   that disables inherited MCP servers and verify it from thread/start evidence.
   agy 1.3.1 has mcp/plugin management subcommands but no per-turn switch:
   determine with isolated fixture configurations whether --sandbox turns load
   ~/.gemini/config/mcp_config.json and plugins and whether agent tools receive
   ANTIGRAVITY_LS_ADDRESS/ANTIGRAVITY_CSRF_TOKEN. Never touch the owner's live
   MCP services. If agy cannot be isolated, propose failing closed for agy and
   ask the owner.
2. CUR-001 and CUR-013. Carry omitted or truncated review input as structured
   completeness, bind the expected snapshot, keep FAIL/NOT_RUN honest, and review
   a non-checkout commit from that commit's tree, not the live workspace.
   Acceptance is in AUDIT-001.
3. Tester material (BETA-001): a GitHub bug-report issue template asking for
   issue/doctor output, OS, Node and CLI versions; a short tester guide in README
   (install the VSIX, run CoAgent8: Set Up Coding CLIs, report a bug); a beta.2
   release-note draft with known issues and security notes from
   RUNTIME_CONTRACT section 7.
4. A real Windows check that consult and review open no visible windows, with
   the helper launch count (ask before any model turn that needs consent).
5. The full local gate on the current branch: typecheck, build, test,
   npm pack --dry-run (inspection only), test:consumer, package:vscode. Report
   the VSIX path and SHA-256.
6. INSTALL-001: implement the owner's choice for the welcome notification
   (recommended: show until a CLI is ready or Don't Show Again; ask first).

Report after each step: what is done, the evidence, the files changed and open
owner decisions. Local checks are not independent review or release approval.
~~~

The snapshot and branch ledger below remain historical context for the broader
audit stack.

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
merged, matrix-verified or released candidate. Package metadata is beta.2, an
unpublished development candidate for private testing.

New open findings concern incomplete review input/approval binding, inherited
Codex/agy MCP capabilities, automatic-routing cache
failures, sticky commentary limits, concurrent cache misses and request-budget
scope. The runtime contract lists these as `CUR-001` through `CUR-013` (`CUR-012` is source-inspected capacity accounting;
`CUR-013`, a review of another revision reading the live workspace, came from the
owner's VS Code retest).
`CUR-003` (accepted consent without the checkbox) is closed on `fix/explicit-consent`.

Archival off does not mean session-free execution. Catalog validation is
best-effort. Consent is decided by approximate price (`feat/price-based-consent`);
model catalogs and defaults come from the CLIs and `config.json`
(`refactor/model-catalog-cache`). Claude's recorded default `claude-opus-5-5`
costs 20 USD per million output tokens, at the default limit, so it asks on every
turn until the owner relaxes `governance`. Do not document them as existing
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
| `refactor/model-catalog-cache` | `1d3c8dc` | No model names in `src/` code (governance aside); defaults from the CLIs and `config.json`; catalogs in `models.json`; Claude names resolved through `system/init` |
| `feat/price-based-consent` | `ce882ba` | Consent by approximate price (OpenRouter): relative to the default, a 20 USD limit, remember for unknown or approximate prices; rule 01 reworded with the owner's confirmation |
| `fix/agy-quiet-updater` | `dcf9a90` | P0 quiet Windows: every agy launch sets `AGY_CLI_DISABLE_AUTO_UPDATE=true`; agy's updater opened a focus-stealing console window (`WINDOWS-001`) |
| `fix/consent-unanswered` | `0c89f70` | A cancelled approval request is reported as unanswered, not as the user's refusal; Codex cancels without showing a form (`EXEC-001`) |
| `docs/vscode-retest` | this change | Owner's VS Code chat retest in `CONTEXT-001`; `CUR-013` (review of another revision reads the live workspace) |

`docs/readme` (`de47a4d`, README feature list and badges) branches from
`feat/price-based-consent` outside this stack; its regenerated `CHANGELOG.md` is
kept in the stash "docs/readme: regenerated CHANGELOG.md (pending chore(changelog))".

## Next work

Order decided by the owner on 2026-10-07: `CUR-003` first (done), then:

1. Done: `refactor/model-catalog-cache` (`EXEC-001`). The recorded Claude
   default on the owner's account is `claude-opus-5-5`.
2. Done: `feat/price-based-consent` (`EXEC-001`), rule 01 confirmed by the owner.
   At 20 USD per million output tokens that Claude default reaches the default
   limit and asks on every turn; headless clients must name a cheaper Claude model
   until the owner relaxes `governance` (`neverAsk` or `askAbovePrice`).
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

The owner's VS Code chat retest of 2026-10-07 is recorded in `CONTEXT-001`. Open
after it:
- the owner's live check of `fix/agy-quiet-updater` in a fresh Codex chat after
  restarting VS Code, with the first Gemini call at least 15 minutes after the
  last agy launch (the bundle is rebuilt; a running server keeps the old one);
- an owner decision on `CUR-013` (review of a commit other than the checkout);
- a consent dialog in a VS Code chat: neither chat showed one, so step 6 can only
  pass in a client that renders MCP forms.

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
