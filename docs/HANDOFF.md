---
title: Handoff
---

# CoAgent8 handoff

Updated 2026-10-12. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities/acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Do not append another session transcript or treat old test counts as fresh evidence.

## LIC-001 MIT candidate

2026-10-12, `chore/mit-relicense`, based on `cccfa9d` (merged PR #16).
The owner instructed implementation of MIT relicensing after that PR.
LICENSE, the four distribution license fields, both README license sections
and contribution guidance now describe MIT for project source, documentation
and artwork. Version remains 0.6.0 until the 0.6.1 release PR. This is a local
candidate, not a replacement for any published 0.6.0 artifact.

Rights/material inventory:

- Inspected all 302 tracked files by category: 113 source files, 107 tests and
  fixtures, six client skills, 25 artwork files, 19 documentation/rule files
  and 32 other files. Existing project copyright attribution identifies
  Oktawian Wybieralski (oki.dev), and rule 02 section 2 records the owner as
  sole author and copyright holder of the project work. The owner's instruction
  authorizes this project license change. History has the owner's two email identities only,
  which is corroborating attribution, not proof of rights to imported work.
- Searched tracked text for copyright/SPDX/license notices and copied/adapted/
  derived-material attribution. No additional first-party copyright holder or
  GPL-only imported code was identified. Artwork includes the Affinity source,
  SVGs and PNG derivatives. Generated server icon comes from project artwork.
- Test doubles implement provider protocols; recorded CLI outputs and the
  abridged OpenRouter model/pricing data are external fixture data. The change
  makes no new ownership claim over vendor responses, protocols or model names.
  No vendor CLI implementation is distributed with the package.
- All three lockfiles contain no dependency license labeled GPL. The bundle's
  notice inventory contains MIT packages (@modelcontextprotocol/sdk, ajv,
  ajv-formats, fast-deep-equal, json-schema-traverse, jsonc-parser, zod) and
  BSD-3-Clause packages (fast-uri, smol-toml). Their license texts remain intact.
  Private documentation/VSIX tooling manifests have no project license field
  to change; their dependency licenses are untouched.
- Previously distributed GPL copies retain their permissions. Historical tags,
  release packages and generated changelog entries were not rewritten.
  PUBLIC-001d's separate trademark notice remains pending owner wording approval.

Local evidence, Windows 11 / Node v26.10.0: PASS typecheck,
`check:dependencies`, fresh build, package regressions (7 pass / 0 fail),
consumer smoke (installed package startup/tool discovery, fixture turns/history,
setup dispatch and EOF), VSIX packaging and exact-artifact inspection.
The consumer tarball equals the one used to stage the VSIX. MIT LICENSE and
metadata are present in both, and the third-party notices are byte-identical
to the pre-change build (SHA-256
`b29a2a04d624f9c7630c56db62474732c6a12911ac5061657754aea91c91cb67`).

- Tarball SHA-256:
  `4b08507efe101ce104f39ecf09e8b183fa9317fe545b175a1965fd63305e4ec3`.
- VSIX SHA-256:
  `ed1a17e5588ac25d155d6d5d93716cf3a9b720f6d72dc08f07db8b13ebd42852`.

NOT_RUN: native host acceptance, published MIT artifact verification and Socket
remeasurement; these belong to the 0.6.1 release tasks. Independent review and
integration of this local candidate are pending.

## 0.6.0 release evidence

Release of 0.6.0 (REPO-002 owner steps 1-8), checked again on 2026-10-12 on
Windows 11, Node v26.10.0, from downloads of the published release:

- PASS: `v0.6.0` is an annotated tag on `9b78a0a` (`chore(release): v0.6.0 (#3)`,
  the squash commit on `develop`); `git cat-file -t v0.6.0`, `git rev-parse v0.6.0^{commit}`.
- PASS: `gh release download v0.6.0`; `sha256sum -c SHA256SUMS` OK for
  `coagent8-0.6.0.tgz` (`4bf66c25fa1facf8b23320f3501475361ad7f69b52e15a3e7f99e7219f19500c`)
  and `coagent8-mcp-0.6.0.vsix`
  (`a2bb079f3b8cfa6bf60b3d6267007a0adc2ed50772b346fbe82eb92e072e14d7`). The
  owner's rehearsal (step 5b) reported the same tarball hash; its repository is
  deleted, so that comparison was not repeated.
- PASS: `gh attestation verify <file> -R oktawianwybieralski/coagent8` for both
  files: SLSA provenance v1 from `release.yml` at `refs/tags/v0.6.0`, commit `9b78a0a`.
- PASS: `npm view coagent8`: versions `0.6.0` only, dist-tags `latest` and `next`
  = `0.6.0`; `dist.integrity` (sha512) and `dist.shasum` equal those computed from
  the release tarball. `1.0.0-beta.1` is unpublished, not deprecated.
- PASS: the VS Code Marketplace VSIX `okidev.coagent8-mcp` 0.6.0 is byte-identical
  to the release VSIX (same SHA-256); the owner installed it from the Marketplace.
- PASS: `npx -y coagent8@next` started by an MCP SDK stdio client: server
  `coagent8` 0.6.0, six tools (consult, review, doctor, session, cancel, issue),
  `doctor` without error, `consult` on codex `gpt-6-luna` answered in 3.8 s.
- NOTE: the GitHub Release `v0.6.0` (published 2026-10-11T22:57:25Z) is not
  marked as a pre-release, while rule 02 keeps releases below 1.0.0 as
  pre-releases; the owner decides whether to change it.
- NOTE: the rehearsal repository `coagent8-release-test` no longer exists.
- Open: REPO-002 owner step 9 (npm trusted publishing).

## FEEDBACK-060 native acceptance of 0.6.0

2026-10-11, Windows 11 10.0.26200, Node v26.10.0, isolated VS Code instance
(`--user-data-dir`/`--extensions-dir`) with the VSIX from CI run 38173983280
(`extension.cjs` and `uninstall.cjs` SHA-256 equal to the downloaded VSIX).
Backends: codex-cli 0.162.0-alpha.17.2, Claude Code 2.1.296, agy 1.3.3. Three
agents (Claude Code, Codex, Antigravity) called every tool on the cheapest
model per backend (`gpt-6-luna`, `claude-haiku-5-5`, `gpt-oss-120b`).

- PASS: consult on all three (13524), review found both seeded defects and
  returned READY after the fixes, an unchanged repeat started no turn,
  continuation kept context, history paging, close, issue drafts, workspace
  isolation, cancel of a running Codex and agy turn.
- FAIL/NOTE: findings and their split before/after 0.6.0 are the
  [FEEDBACK-060 cards](ROADMAP.md#feedback-060-findings-of-the-060-native-acceptance).
  Reproduced locally: `git diff --cached` in a repository owned by
  `CodexSandboxOnline` prints dubious ownership, then `unknown option 'cached'`.
- NOT_RUN: cancel of a running Claude turn (inconclusive), `delete_history`.

## REPO-002 first release path (2026-10-11)

GitHub state checked read-only and owner decisions for 0.6.0 recorded in
[REPO-002](ROADMAP.md#repo-002-branch-model-and-release-workflow): the
default branch is `devlop` (rename to `develop` before the PR), the branch
ruleset still targets `main` and `release/*` with Node 20.x/22.x checks,
`release/v0.6.0` is 353 unsigned commits ahead of `b962086`. 0.6.0 reaches
`develop` as one squash commit tagged `v0.6.0`; CI is tested on the draft PR,
packages from its CI artifacts, and `release.yml` in a private rehearsal
repository (owner step 5b). Nothing pushed; all steps remain owner actions.

## PLUGIN-001g VS Code installed-server entry

Commit `1f36525` on `release/v0.6.0` (local, not pushed). Local checks on
2026-10-11: typecheck, `lint:docs`, build, full suite 688 pass / 0 fail
(3 skipped, 1 todo), including `tests/integrations/vscode-profile.test.js`.

Native, VS Code 1.141.0, Windows, default profile, VSIX 0.6.0 installed with
`--force` beside the pinned 1.0.0, then Reload Window:

- PASS: "MCP Servers - Installed" lists CoAgent8 beside GitHub and Context7; its
  page shows type stdio, command `node`, the copy in
  `globalStorage/okidev.coagent8-mcp/runtime/<sha256>/index.cjs` and the four
  environment variables. The user `mcp.json` keeps both gallery entries;
  `~/.coagent8/vscode-mcp.json` records the entry digest.
- NOT_RUN: start and tool discovery from the entry, toggle, output, a setting
  change restarting it, removal in VS Code respected, update to another build,
  uninstall leaving no entry. The pinned 1.0.0 copy is still on disk.

## REPO-003a one numeric version

Owner decision 2026-10-11: previews start at 0.5, so the beta.2 candidate is
`0.6.0`. Card: [REPO-003](ROADMAP.md#repo-003-one-numeric-version-for-npm-vsix-and-tags).
Done locally on `release/v1.0.0-beta.2`, which was then renamed `release/v0.6.0`
on the owner's request (`git branch -m`; no upstream existed). No tag, push or
npm action:

- `package.json`, `package-lock.json`, `plugin.json` and
  `extensions/vscode/package.json` carry `0.6.0`; the changelog scripts start at
  `v0.6.0`. `cliff.toml` renames the curated beta.2 section to `0.6.0` (tag
  `v0.6.0`); `CHANGELOG.md` was regenerated with the same config
  (`git-cliff --config cliff.toml --output CHANGELOG.md HEAD..HEAD`). The
  previous file came from a CRLF working copy of `cliff.toml`, whose blank lines
  escaped the `\n{3,}` postprocessor; generated from the LF file Git stores, three
  surplus blank lines disappear.
- Owner decision 2026-10-11 (same session): beta.1 gets no tag, GitHub Release
  or changelog entry and npm `1.0.0-beta.1` is unpublished, so 0.5.0 is skipped.
  The curated 1.0.0-beta.1 section is removed from the `cliff.toml` footer and
  `CHANGELOG.md`; rule 02, AGENTS.md, README, ARCHITECTURE and REPO-002 owner
  steps 4 and 8 (unpublish after 0.6.0 is on npm) follow. The local tag
  `v1.0.0-beta.1` is untouched.
- `scripts/build-vscode.cjs`: `extensionVersion` refuses a version that differs
  from the server or is not numeric `major.minor.patch`, instead of stripping a
  suffix; `isPreview` (every version below 1.0.0) drives the VSIX pre-release
  flag in `tooling/vscode/package.cjs`. `release.yml` refuses a tag other than
  numeric `vX.Y.Z` and marks a version `0.*` as GitHub pre-release;
  `npm-publish.yml` sends `0.*` to `next`. Provenance steps are unchanged.
- Rule 02 (tags `vX.Y.Z`, previews, line `1.0.x` from the first release
  candidate, the five phases), AGENTS.md, README (tester guide, `npx` example),
  the extension README, ARCHITECTURE decision log, ROADMAP (status, REPO-002 owner
  steps 5, 6 and 8, release acceptance stage numbers). Dated evidence below stays
  as written. An ignored local copy of the prepared notes,
  `.local/release/v0.6.0/release-notes.md`, carries the new number; the beta.2
  copy is unchanged.

Local evidence on Windows 11, Node v26.10.0: PASS `npm run typecheck`,
`npm run build`, `node tests/run.cjs tests/package.test.js` (7 pass, two new
tests: version check, preview rule, manifest agreement), `npm run package:vscode`
(tarball `coagent8-0.6.0.tgz` SHA-256
`e90e972637218371d5a3a0073897ce1cb3a5d3c184433e6d9c0bf7d1c32318b0`; VSIX
`coagent8-mcp-0.6.0.vsix` SHA-256
`0bb40ace577c31a13ed0f13230cbcab77e7c9a66fc78fdbcff33796b3bf0520d`, whose
`extension/package.json` is `0.6.0` and `extension.vsixmanifest` has
`Version="0.6.0"` and `Microsoft.VisualStudio.Code.PreRelease` `true`), both
workflows parse as YAML (`yaml` 2 from `tooling/`), the tag and channel `case`
logic accepts `v0.6.0`/`v1.0.0` and refuses `v1.0.0-beta.2`/`v0.6`,
`npm run changelog:check -- --with-commit "<title>"` exits 0, `git diff --check`.
Full `npm test` from `C:\Users\...`: 682 tests, 678 pass, 0 fail, 3 skipped, 1
todo (the known WINDOWS-001a reproduction); it ran before the beta.1 removal,
which changed only `cliff.toml`, `CHANGELOG.md` and prose, after which the
package test file, changelog check and `git diff --check` were repeated.
NOT_RUN: actionlint (not installed), the workflows on GitHub, independent review,
native VS Code update from one numbered VSIX to the next.

## CLIMGMT-001 manage coding CLIs

Owner request 2026-10-11, implemented on the beta.2 candidate checkout
(`release/v1.0.0-beta.2`, uncommitted). Card:
[CLIMGMT-001](ROADMAP.md#climgmt-001-manage-coding-clis).

- `src/integrations/setup.ts`: `listInstallations` (vendor extension copy, each
  PATH folder, profile installer folders, configured file; no process started, no
  disk scan), `configuredExecutable` and `checkExecutable` (resolve plus
  `inspectCli`; refuses incompatible files) replace `alternativeSource`.
- `extensions/vscode/src/extension.ts`: `coagent8.manageClis` (**Manage Coding
  CLIs**) replaces `coagent8.setup`; `coagent8.uninstall` is removed. A list of the
  three CLIs with two bulk chat actions, then one menu per CLI (installations,
  install, connection, skills, removal of what CoAgent8 installed) that reopens
  after each action. `installExtension` keeps `donotSync` (see below). The update
  notice's **Update CLI Chats** updates outdated chats directly. The one-time
  vendor-extension offer and its `keptStandalone` state are gone; the menu shows
  the install action instead. A vendor extension installed in this window is not
  dropped from `installs.json` while the extension API still lags.
- Standalone removal succeeds when one standalone installation seen before has
  gone (another, such as Scoop's, may stay) and then corrects only a configured
  path that no longer resolves.
- Tests: `tests/integrations/vscode-extension.test.js` rewritten around scripted
  picker steps, with `tests/fixtures/vscode-extension/setup.js` as the setup
  double; three runtime tests in `tests/integrations/setup.test.js`.

Local evidence on Windows 11, Node v26.10.0, VS Code 1.141.0 sources read for
`donotSync` (maps to `isMachineScoped`): PASS `npm run typecheck`,
`npm run lint:docs`, `npm run build`, full `npm test` (679 tests: 675 pass, 0 fail,
3 skipped, 1 todo, the known WINDOWS-001a reproduction). A later
standalone-removal fix and LF normalization were followed by typecheck, build,
the extension, setup and cleanup test files (68 pass) and `npm run package:vscode`
(VSIX SHA-256 `390439647879d478e7a177e4794f35dc712593ed2d6fae9a5e450a61e709353f`).
After the owner's first look (too much text compared with Manage Skills) each CLI
menu line became a short action name: no detail lines, section headers or
information-only lines; the installation in use moved to the placeholder and the
list shows states only. Typecheck, the extension test file (34 pass), build and
`npm run package:vscode` passed again (VSIX SHA-256
`0041b2acabfbc70ef1f85cbdf87a0ae4d00304f2fd9095621f5d247b75d10d06`; its manifest
lists `coagent8.manageClis` and no `coagent8.uninstall`; its bundle has no
`donotSync`). Owner feedback then added Back to every Manage Skills step
(`choose` with `QuickInputButtons.Back`), step counts and only applicable
actions/packages, removed the ellipses from menu labels and moved the `CoAgent8`
prefix of command titles to `category`, after a check against the VS Code UX
guidelines, built-in command, manifest, Settings Sync and MCP documentation.
Typecheck, the extension test file (35 pass), build and `npm run package:vscode`
passed (VSIX SHA-256
`2cc16ae79faccddf0f41caa1c403da8ca163844d71895feb361b47c066fe2354`).
Correction: the owner saw VS Code ask "install and synchronize ... across your
devices?" after `donotSync` was dropped. VS Code 1.141.0 `installFromGallery`
prompts when `isMachineScoped` is undefined and extension sync is on; the earlier
claim that the command asks nothing was wrong. Owner decision: keep `donotSync`
and remove the uninstall confirmation dialog (the notice with Reload Window stays).
Typecheck, the extension test file (35 pass), build and `npm run package:vscode`
passed (VSIX SHA-256
`c0e4c824c5d2b3398023813d1025ef7ead78e33e8812ea8aecd47012d3563278`; its bundle
passes `donotSync`).
The owner then found the flat menu too poor and asked for the earlier sectioned
look, done professionally, also in Manage Skills: sections (Installations,
Install, Chat, Skills, Remove), a codicon per line, short descriptions, no detail
lines except the installation in use in the list of CLIs; Manage Skills shows
state icons per CLI and per action the number of packages it changes.
Typecheck, the extension test file (35 pass), build and `npm run package:vscode`
passed (VSIX SHA-256
`df58db1d7358c94c79e10f2cd441d7a267e3dbfc215d0677c822a2795ff008ee`).
Owner native report: uninstalling a vendor extension worked; the Extensions view's
Restart Extensions then applied it flawlessly, so Reload Window is not needed. VS
Code 1.141.0 offers no command for that action: `uninstallExtension` only marks
the extension `restartExtensions`, and the native button calls the internal
`updateRunningExtensions` with the add/remove delta, which
`workbench.action.restartExtensionHost` lacks. The notice now offers **Open
Extensions** (`workbench.extensions.search` with `@restartrequired`, the query of
VS Code's own banner) instead of Reload Window.
The owner then asked to leave the whole removal to the Extensions view: **Uninstall
VS Code Extension** now records `removingExtensions` in the extension's setup state
and shows the extension (`workbench.extensions.search` with its id); the user runs
VS Code's Uninstall and Restart Extensions. `finishRemovals` completes the record,
selection and agy-download cleanup on `extensions.onDidChange` or at the next
activation, and forgets a removal whose extension is still installed then.
Typecheck, the extension test file (35 pass), build and `npm run package:vscode`
passed (VSIX SHA-256
`e0f3ffc7cd7b0ad8e91dc3fb94fca3c73d40e8ac94eb527e57b4c4f3c0a2b016`).
Closing gate on Windows, Node v26.10.0: typecheck, lint:docs and build PASS; full
`npm test` 680 tests, 675 pass, 3 skipped, 1 todo (WINDOWS-001a) and 1 fail:
`tests/backends/agy/adapter.test.js` "Gemini resolves relative primary and legacy
data directories" compared `c:\...` with `C:\...` because that run started from a
lower-case drive-letter working directory. The file passed (27/27) from
`C:\Users\...`; this change touches no backend file. The drive-letter sensitivity
of that test is a separate pre-existing issue. The versioning follow-up is
[REPO-003](ROADMAP.md#repo-003-one-numeric-version-for-npm-vsix-and-tags).
Typecheck, the extension test file (35 pass), build and `npm run package:vscode`
passed (VSIX SHA-256
`17fb9139c991c8765aa25e3c28dc2e2c288cbc2e2ea4f14a1d700e4f999221f4`).
NOT_RUN: independent review, consumer smoke, native VS Code acceptance
(CLIMGMT-001e).

## Beta.2 issue-link correction (2026-10-10)

The owner reported a malformed prefilled GitHub issue opened from agy.
Local changes in `src/diagnostics/issue.ts` remove the multiline truncation
marker from titles, encode Markdown delimiters in query values and provide an
angle-bracket link destination, copyable URL and plain Markdown report preview.
The issue tool description asks for concise, actionable reproduction steps,
expected/actual behavior, impact and sanitized telemetry: tool/backend/model,
CLI versions, errors, timing and scope/check evidence. Unknown facts must be
marked, never invented. Callers must preserve `issueUrl` verbatim without
decoding or re-escaping it. The owner approved increasing the MCP tool-definition
budget to 5,800 bytes on 2026-10-10 for this instruction; the measured total is
5,746 bytes. `tests/mcp/surface.test.js` records the revised acceptance limit;
the current budget in `docs/ARCHITECTURE.md` and `src/mcp/schema.ts` is synchronized.
The report now retains complete sanitized context and diagnostics instead of
the extra 300/800-code-point cuts. Privacy filtering and the existing 4,096-byte
bound per input field remain; over-limit input retains its truncation marker.

Fresh PASS on Windows with Node v26.10.0: `npm run typecheck`, both focused issue
test files (8 tests), `npm run build`, `npm run lint:docs` and `npm run docs`.
The additional MCP surface and secret-redaction suites pass (20 tests).
A Markdown-it render check confirms the rendered href and decoded title/body
match the sanitized report, including CLI parentheses and redacted secrets/home
paths. Scoped `git diff --check` also passes. The previously reported extra blank
line in `tests/mcp/result.test.js` belongs to separate work and was not edited.
Independent read-only CoAgent8 review (`agy`, `gemini-3.8-flash-high`) returned
`COVERAGE: COMPLETE` and model `VERDICT: READY`, with no P1/P2 findings for this
fix. Reviewer checks were `NOT_RUN`; the server therefore reports `BLOCKED`
for its required-check gate. The PASS evidence above was executed locally by
the implementing agent, not independently by the reviewer; this is not release
approval.
Native agy click-through is NOT_RUN: this review has no access to native agy UI
interaction or its MCP restart. It remains pending under
[beta.2 issue-link acceptance](ROADMAP.md#beta2-issue-link-acceptance).
Existing execution/timing changes in this checkout belong to separate work.

## Analysis follow-up planning

The owner requested correction of the local source-analysis plan and small
assignments for a less capable implementation model on 2026-10-09. The active
queue is [AUDIT-001 corrected analysis follow-up](ROADMAP.md#audit-001-corrected-analysis-follow-up):
21 pending cards, A01-A21, with reproduction gates, dependencies, starting files,
acceptance cases and scope-based checks. No implementation card was started by
this documentation change. On assignment, start with AUDIT-001-A01; existing
EXEC work/evidence below is preserved, and shared-owner changes must be coordinated.

The source assessment used b1dbd99. It rejected the claimed agy unhandled parser
crash, forbidden workspace/runtime dependency, AWS prefix bug, missing doctor
tool bound and ESM build issue. Lease publication/reclamation, both price checks,
documented health diagnostics and history capacity accounting remain contracts.
Quota state loss, configuration locking and caller-specific I/O failures need
reproductions; cache and history optimizations need bounded behavioral evidence.
No P0 incident or native Windows sharing failure was established by that report.

Prior assessment evidence, not rerun for this prose change: dependency checker
PASS; agy adapter plus price-limit tests 26 passed, 1 POSIX-only skipped on
Windows, 0 failed. The local SUMMARY/INDEX are corrected reference material;
all 11 historical module reports now carry superseded notices. Required task
instructions live in ROADMAP and do not depend on those untracked local files.

Documentation validation PASS: content review against source/contracts,
21 ordered unique cards with required fields and earlier-card dependencies,
30 source/test references, 38 local links/anchors plus the foundation-section
cross-reference, 11 superseded notices, ASCII roadmap addition and
git diff --check. Runtime tests, builds and backend calls were not rerun for
this prose-only update. No source, architecture contract or Git integration
change is included.

## Scope and decisions

The owner requested analysis of three agents' arithmetic trials and consolidation
around these three documents. The target is full MCP orchestration: complete tasks,
write/check/fix workflows, independent roles/models and installable client skills.
Current read-only profiles remain enforced until verified replacements land.
AX-001/002 (per-model prices and the price limit) were implemented on
feat/ax-price-selection, branched from docs/coagent-direction at 3a9a4bb.
The current local implementation is SKILLS-002a/b (independent skill management),
added after EXEC by owner authorization. Current branch:
`release/v1.0.0-beta.2`; the owner's existing stack remains intact.
Next acceptance: SKILLS-002c, the post-uninstall Reload Window case and affected
EXEC-001-T12c/d release evidence. Local tests do not establish native acceptance
or approve publication; see the final candidate evidence below.

The 2026-10-09 roadmap refinement also separates AX implementation/native
acceptance, adds coagent contract cards before speculative implementation and
splits CLI/foundation acceptance into smaller assignments. Preserve the
milestone acceptance criteria when expanding later code cards. This refinement
changes plan/evidence prose only; validation is source/path/link review and
git diff --check, not another runtime/package test run.
PASS for this refinement: local links/anchors and source starting paths,
40 ordered EXEC cards with unique IDs and valid references, all 36 listed
test-group paths, ASCII punctuation and git diff --check. Runtime checks
were not repeated for these Markdown-only changes.

Preserve the local stack and owner-managed Git integration; no new checkout,
reset, merge, push or publication is part of this handoff. Inspect status again
before editing. Development targets `develop` under the repository Git rules
(owner decision 2026-10-10; migration in REPO-002).

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

The next authorized work boundary is owner inspection of
[SIMPLIFY-001 S5](#simplify-001-s5-implementation). On continuation, execute S6 in the
[roadmap's order](ROADMAP.md#execution-checkpoints), with its boundary enforcement and
scope-based checks, then stop again. S1, S2, S3, S4, and S5 modules are implemented and verified;
automated dependency enforcement remains scheduled for S6.
Recheck the current checkout rather than assuming that the baseline below is still current.
The migration does not change the release status or make historical runtime evidence fresh.

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

Remaining AX work: independent review of the feat/ax-price-selection work, then
AX-003/004/005/006 for approval transport, effective config, readiness and
fresh-client acceptance. Keep consent
fail-closed and never insert a model into neverAsk. Design COAGENT-001/002
alongside, then one verified host-led write/check/review path before delegated
coordinators, preserving the roadmap's root-budget, writer, interruption and
evidence criteria.

Open runtime limitations and the CUR items with local fixes are listed in
[ARCHITECTURE.md](ARCHITECTURE.md#known-limitations); do not reimplement fixed
items from an old snapshot report. Revalidate the candidate before claiming acceptance.

## SKILLS-001 client skills

Requested by the owner on 2026-10-10 for beta.2, before EXEC-001-T12
([cards](ROADMAP.md#skills-001-client-skills-installed-with-the-registration)).
SKILLS-001a-d are implemented locally on `perf/exec-001`. The roadmap cards and
this section entered commit 2ba3bc9 (EXEC-001-T11a) together with that card's
documents; the code, skills, README and architecture follow in their own commit.
During this work the uncommitted SKILLS files were once deleted outside Git (no
stash, branch switch or reflog entry) and were recreated from the session.

Changed: `skills/` (six packages), `src/integrations/skills.ts`, `setup.ts`,
`setup-storage.ts`, `cleanup.ts`, `setup-cli.ts`,
`extensions/vscode/src/extension.ts` and `uninstall.ts`,
`scripts/build-vscode.cjs`, both `package.json` file lists,
`tests/integrations/skills.test.js` and `tests/consumer/smoke.cjs`.

Evidence, Windows, 2026-10-10: `npm run typecheck` PASS;
`npm run check:dependencies` PASS; `npm run lint:docs` PASS; `npm run docs` PASS;
`node tests/run.cjs tests/integrations/skills.test.js` 7/7 PASS;
`node tests/run.cjs tests/integrations/setup.test.js tests/integrations/cleanup.test.js tests/integrations/vscode-extension.test.js tests/integrations/cli-readiness.test.js tests/package.test.js`
70/70 PASS; `npm pack --dry-run` lists the six SKILL.md files. NOT_RUN: the
consumer smoke, VSIX packaging, the six-job matrix, independent review and
native discovery in each client (SKILLS-001e). The loader evidence in the card
comes from the installed CLI versions and their documentation; no client listed
or invoked a CoAgent8 skill yet.

Next: SKILLS-001e as part of T12's native checks. Resolve the agy directory there
(`~/.gemini/config/skills` per the bundled 1.3.2 guide, against the web docs'
`~/.gemini/antigravity-cli/skills`).

## SIMPLIFY-001 S0 baseline

Captured 2026-10-08 before documentation edits, on Windows, Node v26.10.0,
npm 11.19.1. Scope: static baseline and sequential implementation checkpoints.
No source migration, Git integration, live configuration edit or model turn.

### Checkout and evidence identity

- Initial inventory branch: `feat/ax-price-selection`.
- Working branch: `refactor/simplify-001`, created at the same HEAD after the
  owner authorized branch separation during S0. The two documentation edits
  were preserved across `git switch -c refactor/simplify-001`.
- HEAD: `ac394adf3ae31181f88a210d07c1d5a1d4e0fdde`.
- Tree: `e2ad8e735630336c4721428207bf978519e13d8c`.
- Local `release/v1.0.0` and merge base:
  `ae55f017fdc7f54776549b94ea5d2e9833601894`.
- `git rev-list --left-right --count release/v1.0.0...HEAD`: `0 199`.
  This is the existing local stack, not a newly integrated release branch.
  The owner authorized preserving this stack as the topic branch's starting
  point. Integration into release/v1.0.0 remains owner-managed; this branch
  operation is not evidence of an up-to-date release base or merge readiness.
- Initial and pre-edit `git status --short --branch`: clean on the initial branch.
  `git worktree list --porcelain`: one worktree. The collaboration roster showed
  only this agent. These observations cannot exclude an external editor/process;
  re-read touched files before every edit. No stash/reset/rebase/new checkout.

Optional ignored evidence is under `.artifacts/simplify-001/`:
`inventory.cjs`, `baseline-graph.json`, `baseline-state.json`, `references.txt`
and `legacy-table.md`. These are inspection artifacts, not another active plan.
The required debt decisions and findings are recorded here. Reproduce the graph
on the recorded source with `node .artifacts/simplify-001/inventory.cjs` while
that local script is available; S6 must supply maintained graph enforcement.

Graph SHA-256:
`3dc8703cc840437cf3a38f01326836b1c4e1fa91d8b70c22525b7d066425bc8f`.
Inventory script SHA-256:
`16024718bb163fefaa06c866f6a125fa51f4c868282a19b086f599266665a4c6`.

### Actual graph and cycles

The inventory parses all 158 tracked TS/JS/CJS/MJS files, including 77 source
modules and the extension/tests/tooling. It resolves relative `.js` imports to
their `.ts` source, records bindings/line numbers and distinguishes imports,
explicit type imports, import type queries, dynamic calls and re-exports.
All parsed files had zero parser errors; no literal relative import was
unresolved. This does not validate computed paths or packaged files.

Source has 410 dependency declarations: 352 ordinary imports, 56 explicit
type imports, one type query and one re-export. There are 329 internal source
edges. Symbol-aware TypeScript 6.0.3 emit from the already-installed documentation
tooling, captured only in memory, identifies 272 runtime edges and 57 erased
type edges. Two ordinary declarations are erased despite lacking `import type`:
`backends/availability.ts:5 -> backends/types.ts` and
`sessions/session.ts:5 -> sessions/types.ts`. This is static classification,
not a fresh TypeScript 7.0.2 gate, bundle build or runtime observation.

| Graph | Exact cycle edges (paths relative to src/) | Removal owner |
| --- | --- | --- |
| Runtime | `sessions/session.ts:10 -> sessions/history.ts`; `sessions/history.ts:37 -> sessions/session.ts` | S4: narrow activity/lease contract; preserve lock order and eviction protection |
| Types plus runtime | Above runtime cycle plus `sessions/history.ts:27 -> sessions/history-page.ts`; `sessions/history-page.ts:2 -> sessions/history.ts` (History type) | S4: history-owned snapshot contract; no page/reader cycle |
| Types plus runtime | `integrations/setup.ts:29 -> integrations/cli-readiness.ts`; `integrations/cli-readiness.ts:7 -> integrations/setup.ts` (SetupClient type) | S5: import the existing setup-clients owner directly |

One source re-export exists: `integrations/setup.ts:27 -> setup-clients.ts`
exports SETUP_CLIENTS and the SetupClient type. Its consumer surface must be
classified before removing any forwarding path. No literal runtime dynamic
import exists under src/. The type query at `index.ts:12 -> integrations/setup-cli.ts`
does not eagerly load setup; the adjacent computed runtime require deliberately
loads sibling `setup.cjs` only for setup/repair/status/cleanup/help dispatch.

Three further computed calls were inspected separately: the gated maintenance
fixture resolves `src/stdio-server.ts`; two VS Code fixture VM callbacks use
`require(name)` to supply mocked vscode or native dependencies. The reference
sweep covers launch arguments, esbuild fixture interceptors and embedded code
strings that a literal import graph cannot treat as ordinary source edges.

### Exact migration debt and caller ownership

Paths below are relative to src/ unless prefixed with extensions/. These rows
record exact existing edges/callers, not directory-wide dependency exemptions.
Allowed adapter/application consumption of a mechanism also needs updating
when its current mixed owner splits. All source/test/fixture callers must be
updated in the slice that changes their dependency, not deferred to S5.

| Slice | Current target | Exact consumers | Required ownership change |
| --- | --- | --- | --- |
| S1 | `sessions/lock.ts` | `extensions/vscode/src/configuration.ts:5`, `backends/availability.ts:7`, `backends/model-store.ts:20`, `config.ts:7`, `integrations/cleanup.ts:12`, `integrations/setup.ts:22`, `sessions/history.ts:30`, `sessions/session.ts:7` | File locking and atomic writes belong to storage |
| S1 | `execution/stream.ts` | `extensions/vscode/src/configuration.ts:4`, `backends/availability.ts:10`, `backends/codex/adapter.ts:14`, `backends/model-store.ts:19`, `backends/prices.ts:22`, `config.ts:6`, `execution/cli-resolver.ts:4`, `execution/git.ts:4`, `integrations/setup-storage.ts:10`, `integrations/setup.ts:15`, `integrations/vscode-profile.ts:4`, `sessions/history.ts:34`, `sessions/lock.ts:25`, `sessions/session.ts:9` | Bounded file reads belong to storage; split mixed imports |
| S1 | `execution/stream.ts` | `backends/agy/collector.ts:2`, `backends/claude/collector.ts:2`, `backends/codex/collector.ts:2`, `diagnostics/issue.ts:21`, `execution/controller.ts:48`, `execution/git.ts:4`, `execution/process.ts:31`, `execution/stream-reducer.ts:2`, `integrations/rpc.ts:8`, `redaction.ts:2`, `sessions/history.ts:34` | Byte/line primitives belong to execution/runtime; shared errors must retain identity without loading application policy |
| S1 | `sessions/identity.ts` | `server.ts:27`, `sessions/history.ts:32`, `sessions/session.ts:11` | canonicalPath belongs to workspace; sanitizeHandle stays with sessions |
| S1 | `backends/model-identifier.ts`; `backends/governance.ts` | `config.ts:8` (runtime syntax validator); `config.ts:9` (GovernanceSettings type) | Independent syntax/settings contracts prevent config/models reverse dependency during S3 |
| S2 | `tools/result.ts`; `tools/review-gate.ts` | `execution/controller.ts:51` (formatter); `execution/controller.ts:55` (ReviewGateContext type) | Neutral execution result; review-owned contract, transport-owned formatting |
| S2 | `execution/git.ts`; `tools/review-gate.ts` | `tools/review-input.ts:3,4`; `tools/review.tool.ts:5` (Git); `tools/result.ts:17` (gate) | Review policy/input belongs to review; Git evidence belongs to workspace; handlers format the outcome |
| S2 | `diagnostics/issue.ts` | `tools/result.ts:15`, reached transitively by controller | Keep diagnostic presentation at transport edge; do not import it back into execution |
| S3 | `backends/registry.ts`; `backends/probe-cache.ts` | `backends/model-selection.ts:18,19` | Keep pure policy in models; move native observation/selection orchestration to application |
| S3 | `backends/model-selection.ts` | `backends/consent.ts:11`; `diagnostics/doctor.ts:5`; `execution/controller.ts:39` | Shared pure policy plus application consent sequencing; update doctor in S3 |
| S3 | `backends/consent.ts` | `execution/controller.ts:43` | Split governance decisions from default observation, price reads and sequencing |
| S3 | `backends/registry.ts`, `backends/probe-cache.ts`, `config.ts`, `backends/availability.ts` | `backends/routing.ts:1,2,3,4`; controller calls routing at `execution/controller.ts:36` | Application owns routing composition; native probes/quota/cache remain backend-owned |
| S4 | `sessions/history.ts` | `sessions/session.ts:10`; `sessions/history-page.ts:2` | Remove both recorded cycles; split reader/recovery, writer and retention/capacity without duplicate state |
| S4 | `sessions/session.ts` | `sessions/history.ts:37` | Activity/lease evidence contract instead of session-service dependency |
| S4 | `sessions/history.ts` internal credential boundary logic | computeSafeCommitPoint and its writer use | Move safe credential fragments together with redaction to security; preserve persisted/public bytes |
| S5 | `integrations/setup.ts` | `integrations/cli-readiness.ts:7` (type) | Use setup-clients.ts; remove the recorded type cycle |
| S5 | Existing physical paths and setup re-export | Extension/source-test/build/reference inventory below | Finish consumers and genuine mixed responsibilities; remove stale internal aliases, preserve public paths |
| S6 | Missing dependency enforcement | `package.json` scripts and `.github/workflows/ci.yml` have no boundary check | Enforce actual runtime/type/dynamic/re-export graph and isolated negative fixtures; no directory exclusions |

Shared conversation/provider/error/event and adapter/catalog/quota contracts
currently live in conversation.ts and backends/types.ts; split cohesive shared
contracts in S1, keeping adapter-local types with backends. paths.ts currently
mixes data-directory resolution and workspace choice; split those in S1.
constants.ts mixes branding and MCP tool names; separate the tool constants
with MCP in S2. Generated SDK Icon typing remains a transport asset, not a
shared domain contract. These are ownership splits, not moves of whole files
under misleading directory names.

### Entrypoints, consumers and generated references

- Package main and both bin names resolve to `dist/index.cjs`; `index.js` is
  the compatibility wrapper. mcp.json loads `${PLUGIN_ROOT}/dist/index.cjs`.
  package.json ships src/, dist/, selected branding assets and plugin manifests.
- scripts/build.cjs has separate `src/index.ts -> dist/index.cjs` and
  `src/integrations/setup-cli.ts -> dist/setup.cjs` entries, source maps and
  THIRD_PARTY_NOTICES.txt. Preserve the sibling bundle's lazy runtime require
  and constants.ts's relative package.json lookup when changing depth.
- scripts/branding.cjs generates src/generated/server-icon.ts from the two
  64x64 PNG assets and copies the two 256x256 images. server.ts consumes the
  generated icons; build regeneration must agree with tracked generated source.
- scripts/build-vscode.cjs bundles extension.ts and uninstall.ts and copies the
  exact server/setup runtime set. package-artifacts.cjs obtains runtimes from an
  npm tarball; tooling/vscode/package.cjs consumes that staged package. Preserve
  extension main/uninstall entrypoints and artifact provenance.
- 59 test files are discovered through the existing discovery helper; no test
  was executed by counting them. There are 232 literal source import edges
  from 59 non-src code files, including 13 extension-to-source edges. The full
  graph identifies their exact files/lines; the reference sweep has 299 lines.
- Extension configuration imports stream/lock; extension.ts imports setup,
  cleanup, redaction, config, vscode-profile, cli-resolver, config-overrides and
  setup-storage; uninstall.ts imports cleanup, setup-storage and redaction.
  vscode-profile.ts has no incoming src/ import but has extension/test callers;
  it is not an orphan. index.ts is the deliberate root entrypoint.
- MCP e2e launches src/index.ts through tsx; the gated fixture launches
  src/stdio-server.ts. Setup tests and package tests inspect existing dist/.
  Consumer smoke imports the source CLI resolver, installs a tarball and compares
  shipped bundles to a fresh source build. VS Code tests bundle extension source
  and intercept old source paths in fixture plugins. Update those paths in their
  owning slice and build before tests that require current dist/ evidence.
- Typecheck covers src/ and extension source; TypeDoc expands ../../src.
  CI has six OS/Node jobs with typecheck, docs lint, build, coverage, package
  inspection and consumer smoke; documentation generation and VSIX packaging
  are scoped within that matrix. S6 must add enforcement without bypassing gates.

Existing ignored bundles were hashed, not rebuilt or accepted as current source:
index.cjs SHA-256
`57a0014ad5d7fabe7050781bce2573e3abcb48e543fcd6f5ad0c0e7ec75e0e7c`;
setup.cjs SHA-256
`4dc9c940f923f3f20ce77c27ad53a85975879e72397d4e76b6533e302c1fe8db`.
baseline-state.json records their sizes and the license-notice hash.

### S0 checks and acceptance limits

PASS: checkout/status/worktree observations; AST import inventory and explicit
computed-call inspection; cycle/caller/build/reference review; existing test
discovery enumeration; changed Markdown content/local links/anchors/ASCII review
and `git diff --check`. Source hashes are captured in the graph to detect drift.

NOT_RUN: runtime typecheck, tests, build, docs tooling, package/consumer/VSIX
checks, backend calls, independent review and remote/native acceptance. S0 changes
only plan/evidence prose; these gates belong to the affected migration slices.
No fresh runtime failure or pass is established. The unexplained historical
cross-process lock-test failure below remains a baseline risk; if it recurs,
retain the failure log and investigate rather than relabel a retry as a fix.
The three recorded import cycles precede migration and are existing debt.

## SIMPLIFY-001 S1 implementation

Captured 2026-10-08 after S1 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/contracts/`: Cohesive contracts created for `provider.ts`, `error.ts`, `conversation.ts`, `execution.ts`, `models.ts` (including `isValidModelIdentifier`), `quota.ts`, and `governance.ts` (`GovernanceSettings`, `ConsentBasis`). `src/conversation.ts` and `src/backends/types.ts` forward shared contracts.
- `src/storage/`: Atomic file locking (`storage/lock.ts`: `withFileLock`, `atomicWrite`, `LockTimeoutError`, `inProcessLocks`) and bounded file reads (`storage/read.ts`: `readBoundedFile`, `readBoundedFileSync`). `sessions/lock.ts` forwards to `storage/lock.js`.
- `src/execution/runtime/`: Byte/line decoding primitives extracted to `execution/runtime/stream.ts` (`truncateToByteLength`, `createLineDecoder`, `BufferLimitError`). `execution/stream.ts` forwards to runtime and storage. Runtime has zero imports of `controller.ts`.
- `src/workspace/`: Canonical workspace identity moved to `workspace/identity.ts` (`canonicalPath`), and workspace resolution to `workspace/workspace.ts` (`chooseWorkspace`, `resolveWorkspacePath`, `WorkspaceSource`, `ResolvedWorkspace`). `sessions/identity.ts` retains `sanitizeHandle` and forwards `canonicalPath`. `paths.ts` isolates `getDataDir` and forwards workspace resolution.
- Consumer updates: `config.ts`, `availability.ts`, `model-store.ts`, `prices.ts`, `codex/adapter.ts`, `git.ts`, `cli-resolver.ts`, `setup.ts`, `cleanup.ts`, `setup-storage.ts`, `vscode-profile.ts`, `server.ts`, `result.ts`, `session.tool.ts`, and `extensions/vscode/src/configuration.ts` all updated to consume `storage/`, `workspace/`, `contracts/`, and `execution/runtime/`.
- No consumer in config, model stores, or integrations depends on session implementation or application execution for file operations.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s1.test.js` (4/4 tests pass).
- PASS: `node tests/run.cjs` (392 tests: 389 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S1 completed and reviewed with VERDICT: READY (b4f05f3).

## SIMPLIFY-001 S2 implementation

Captured 2026-10-08 after S2 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/workspace/git.ts`: Git evidence extraction (`collectGitScope`, `snapshotId`, `assertReviewWorkspace`). `src/execution/git.ts` forwards to it.
- `src/review/`: Dedicated review input and verdict policy module (`review/gate.ts`: `evaluateStateEnvelopeGate` (server verdict and causes; the reviewer text is never rewritten), `StateEnvelopeEvaluation`, `ReviewGateContext`; `review/input.ts`: `collectReviewInput`, `proseOnly`; `review/index.ts`). `src/tools/review-gate.ts` and `src/tools/review-input.ts` forward to it.
- `src/contracts/execution.ts`: `TaskExecutionResult` and `ExecutionMeta` defined as neutral contracts with zero transport/Markdown dependencies.
- `src/execution/controller.ts`: `executeTask` neutralised to return pure `TaskExecutionResult` (no `content` array, no Markdown wrapping, no MCP SDK imports). Stripping ANSI moved to `cli-output.ts`.
- `src/mcp/`: Transport layer isolated under `src/mcp/`:
  - `mcp/server.ts`, `mcp/stdio-server.ts`, `mcp/result.ts` (`formatExecutionResult`, `withWorkspace`, `ExecutionToolResult`), `mcp/progress.ts` (`createProgressReporter`), `mcp/schema.ts`, `mcp/constants.ts`, `mcp/arguments.ts`, `mcp/index.ts`.
  - Transport tool handlers moved to `src/mcp/tools/` (`consult.tool.ts`, `review.tool.ts`, `doctor.tool.ts`, `session.tool.ts`, `issue.tool.ts`, `legacy.ts`, `run.tool.ts`).
  - Compatibility shims maintained at `src/server.ts`, `src/stdio-server.ts`, `src/constants.ts`, and `src/tools/*`.
  - `src/index.ts` simplified to dispatch only (`./mcp/stdio-server.js`).
- `src/brand.ts`: Leaf branding module extracted to prevent reverse runtime dependencies from backends and diagnostics into `mcp/constants.js` via `constants.js`.
- Clean architectural boundaries verified: zero runtime or type imports from `mcp/` or `@modelcontextprotocol/sdk` inside `src/execution/` or `src/review/`. Also verified zero `constants.js` or `mcp/` imports inside `src/backends/` and `src/diagnostics/`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s2.test.js` (3/3 tests pass).
- PASS: `node tests/run.cjs` (395 tests: 392 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S2 completed and reviewed with VERDICT: READY.

## SIMPLIFY-001 S3 implementation

Captured 2026-10-09 after S3 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/models/`: Dedicated model domain modules extracted with zero dependencies on `backends/`, `execution/`, or `mcp/`:
  - `models/catalog.ts`: Pure catalog rules (`findCatalogEntry`, `describeModels`, `lookupName`, `checkModelSelection`).
  - `models/identifier.ts`: Model identifier syntax validation (`isValidModelIdentifier`).
  - `models/store.ts`: Pure disk store for `models.json` (`readObservedModels`, `recordObservedModels`, `readStoredPrices`, `recordPrices`, `readObservedModelNames`).
  - `models/prices.ts`: Price evidence, fetching, matching, and limit checks (`readPrices`, `checkPriceLimit`, `priceEvidence`, `findPrice`, `isPriceListStale`, `matchPrices`, `parsePriceList`, `refreshPrices`, `settlePriceReads`).
  - `models/governance.ts`: Pure consent rules (`decideConsent`, `consentRequiredMessage`, `consentDeclinedMessage`, `consentUnansweredMessage`).
  - `models/selection.ts`: Pure selection policy decisions (`catalogDefault`, `catalogNames`, `choosePricedModel`, `listModelCandidates`, types `ModelCandidate`, `ModelSelection`, `ModelSource`, `PriceConstraint`).
  - `models/index.ts`: Public barrel exports for `models/`.
- `src/execution/`: Application operations extracted:
  - `execution/selection.ts`: Native observation and effective model selection orchestration (`selectModel`), composing pure policy from `models/` with native probes from `backends/probe-cache.js`, `backends/registry.js`, and `config.js`. Shared by both execution and diagnostics (`doctor.ts`).
  - `execution/consent.ts`: User consent sequencing (`consentFor`).
  - `execution/routing.ts`: Provider routing composition moved from `backends/routing.ts` (`resolveBackend`, `resolveBackendForModel`, `providerForClient`, `setCallerProvider`).
- `src/backends/`: Compatibility forwarding shims maintained at `src/backends/model-catalog.ts`, `src/backends/model-identifier.ts`, `src/backends/model-store.ts`, `src/backends/prices.ts`, `src/backends/governance.ts`, `src/backends/model-selection.ts`, `src/backends/consent.ts`, and `src/backends/routing.ts`.
- Consumer updates: `src/execution/controller.ts`, `src/diagnostics/doctor.ts`, `src/backends/probe-cache.ts`, `src/mcp/server.ts`, `src/mcp/stdio-server.ts`, and `src/mcp/result.ts` updated to consume canonical modules from `models/` and `execution/`.
- Architectural boundary invariants verified: `models/` has 0 dependencies on `backends/` or `execution/`; `backends/` has zero dependencies on application routing or selection orchestration.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s3.test.js` (5/5 tests pass).
- PASS: S3 scoped test suite: 57/57 tests pass (`tests/simplify-s3.test.js`, `tests/backends/model-catalog.test.js`, `tests/backends/model-identifier.test.js`, `tests/backends/model-selection.test.js`, `tests/backends/price-limit.test.js`, `tests/backends/governance.test.js`, `tests/backends/routing.test.js`, `tests/backends/probe-cache.test.js`, `tests/execution/model-routing.test.js`, `tests/execution/price-limit.test.js`, `tests/diagnostics/doctor.test.js`).
- PASS: `node tests/run.cjs` full test suite (406 tests: 403 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: stop after S3 for owner inspection and independent review (codex sol-6.1). Do not proceed to S4 without owner instruction.

## SIMPLIFY-001 S4 implementation

Captured 2026-10-09 after S4 implementation.
Branch: `refactor/simplify-001`.

### Modules and ownership changes:
- `src/security/`: Dedicated security and redaction boundaries extracted:
  - `security/redaction.ts`: Automated secret redaction for credentials, tokens, and sensitive diagnostics (`redactCredentialFormats`, `redactSecrets`, `redactDiagnostic`).
  - `security/boundaries.ts`: Safe credential stream fragment commit calculation (`computeSafeCommitPoint`, `isPotentialSecretPrefix`).
  - `security/index.ts`: Barrel exports for `security/`.
  - Compatibility forwarding shim maintained at `src/redaction.ts`.
- `src/sessions/activity.ts`: Narrow activity and process liveness inspection (`isProcessAlive`, `getSessionsDir`, `getSessionFilePath`, `isSessionActive`, type `SessionActivityChecker`).
- `src/contracts/session.ts`: Narrow `SessionActivityChecker` contract defined in `contracts/`.
- `src/sessions/history/`: History split into cohesive single-responsibility modules:
  - `history/types.ts`: History snapshot types (`History`, `CachedHistorySnapshot`), limits (`SESSION_LIMIT`, `TOTAL_LIMIT`), path resolvers, and event validation (`validateEvent`, `sanitize`, `cloneEvent`, `cloneHistory`).
  - `history/page.ts`: Pure pagination of validated history snapshots (`paginateHistory`, `PAGE_LIMIT`).
  - `history/retention.ts`: Directory capacity accounting, eviction, and pruning (`pruneHistoryDirectory`, `evictOldestSessions`, `reserveCapacity`, `releaseCapacity`, `sessionMayBeActive`, `setSessionActivityChecker`, `adjustCapacityMeta`). Connects to `isSessionActive` via narrow activity contract.
  - `history/reader.ts`: History snapshot reading, cache management (`clearHistoryCache`, `invalidateHistoryCache`), and crash recovery (`load`, `getHistory`, `sessionHistory`, `deleteHistory`, `getTurnMapping`).
  - `history/writer.ts`: Append-only history writing, streaming delta coalescing, torn-tail truncation, and atomic JSON snapshots (`createHistoryWriter`).
  - `history/index.ts`: Unified barrel exports for `history/`.
- Compatibility forwarding shims maintained at `src/sessions/history.ts` and `src/sessions/history-page.ts`.
- `src/sessions/session.ts` updated to import `getSessionsDir`, `isProcessAlive`, `getSessionFilePath` from `./activity.js`, and history pruning/cache invalidation from `./history/index.js`.
- Architectural boundary invariants & cycle removals verified:
  - Runtime cycle `sessions/session.ts <-> sessions/history.ts` completely eliminated: `history/` has zero dependencies on `session.ts`.
  - Type cycle `sessions/history.ts <-> sessions/history-page.ts` completely eliminated: `page.ts` depends only on `types.ts`.
  - `security/` has zero dependencies on `sessions/`, `backends/`, `mcp/`, or `controller`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `node tests/run.cjs tests/simplify-s4.test.js` (7/7 tests pass).
- PASS: S4 scoped test suite: 48/48 tests pass (`tests/sessions/history.test.js`, `tests/sessions/history-capacity.test.js`, `tests/sessions/session.test.js`, `tests/redaction.test.js`, `tests/execution/controller-history.test.js`).
- PASS: `node tests/run.cjs` full test suite (413 tests: 410 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S5 complete, stop for owner inspection and independent review (codex sol-6.1). Do not proceed to S6 without owner instruction.

## SIMPLIFY-001 S5 implementation

Executed on 2026-10-09, Windows 11, Node v26.10.0, npm 11.19.1. Scope: finishing
consumers, physical layout, retiring internal shims, test layout mirroring, and eliminating
type cycles without changing public contracts or data formats.

### Structural changes and boundary cleanup:
- Retired and removed all 28 stale internal forwarding files and the `src/tools/` directory:
  - `src/conversation.ts` (replaced by canonical imports from `src/contracts/`)
  - `src/redaction.ts` (replaced by canonical imports from `src/security/`)
  - `src/server.ts` and `src/stdio-server.ts` (replaced by canonical imports from `src/mcp/`)
  - `src/backends/` forwarding shims: `consent.ts`, `governance.ts`, `model-catalog.ts`, `model-identifier.ts`, `model-selection.ts`, `model-store.ts`, `prices.ts`, `routing.ts`
  - `src/execution/` forwarding shims: `git.ts` (workspace), `stream.ts` (runtime/stream & storage/read)
  - `src/sessions/` forwarding shims: `history.ts`, `history-page.ts`, `lock.ts`
  - `src/tools/` shims: `arguments.ts`, `consult.tool.ts`, `doctor.tool.ts`, `issue.tool.ts`, `legacy.ts`, `result.ts`, `review-gate.ts`, `review-input.ts`, `review.tool.ts`, `run.tool.ts`, `schema.ts`, `session.tool.ts`
- Eliminated recorded type cycle:
  - `src/integrations/cli-readiness.ts` now imports `SetupClient` directly from `./setup-clients.js` instead of `./setup.js`.
- Mirrored source owners in unit test layout:
  - `tests/models/`: `governance.test.js`, `catalog.test.js`, `identifier.test.js`, `literals.test.js`, `selection.test.js`, `prices.test.js`.
  - `tests/review/`: `gate.test.js`.
  - `tests/security/`: `redaction.test.js`.
  - `tests/storage/`: `lock.test.js`.
  - `tests/workspace/`: `git.test.js`, `git-fixture.test.js`, `workspace.test.js`.
  - `tests/mcp/`: `server.test.js`, `result.test.js`, `surface.test.js`, `tools/issue.test.js`, `tools/review.test.js`, `tools/session.test.js`.
  - `tests/execution/`: `routing.test.js` moved alongside execution tests.
  - Retired `tests/tools/` directory.
- Preserved distinct test purposes:
  - `tests/e2e/`, `tests/consumer/`, `tests/helpers/`, `tests/fixtures/`.
- Updated all consumer imports across `src/`, `extensions/vscode/src/`, and `tests/` to canonical owning modules.
- Preserved genuinely public compatibility paths:
  - `index.js` compatibility wrapper (delegates to `dist/index.cjs`).
  - `package.json` main (`dist/index.cjs`) and bin (`coagent8`, `coagent8-mcp`).

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run build` (tsdown build completes cleanly in ~2.7 s).
- PASS: `node tests/run.cjs tests/simplify-s5.test.js` (5/5 tests pass).
- PASS: `npm test` (`node tests/run.cjs` full test suite: 418 tests: 415 pass, 0 fail, 3 skipped, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc generates `.artifacts/api-docs` with 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

Next action: S5 complete; proceed to S6 under owner direction.

## SIMPLIFY-001 S6 implementation

Executed on 2026-10-09, Windows 11, Node v26.10.0, npm 11.19.1. Scope: automated
dependency boundary and cycle enforcement, test fixtures for forbidden edges/cycles,
wiring into local and CI verification, and updating architecture documentation.

### Structural changes and boundary enforcement:
- Added `scripts/check-dependencies.cjs`:
  - Parses real module graph using TypeScript AST (`import`, `export`, `dynamic-import`, `require`, `type-query`, `import-equals`).
  - Distinguishes runtime vs type-only elided edges via in-memory compiler emit.
  - Implements Tarjan's Strongly Connected Components (SCC) algorithm to detect both runtime and type-level dependency cycles.
  - Enforces architectural boundary rules across all 15 target owners with zero legacy exemptions allowed (`allowedLegacyEdges: []`).
  - Reports unresolved relative imports, parse errors, cycles, and boundary violations with clear rule rationale and source line numbers.
- Cleaned remaining indirect backend type import in `src/mcp/result.ts`:
  - `TerminalExecutionResult` now imported directly from `../contracts/execution.js` instead of `../backends/types.js`.
- Wired into tooling and verification workflows:
  - Added `"check:dependencies": "node scripts/check-dependencies.cjs"` script to `package.json`.
  - Added `Verify dependency boundaries` step to `.github/workflows/ci.yml`.
  - Added `check:dependencies` to required local evidence in `.agents/rules/04-quality-gate.md`.
  - Updated `docs/ARCHITECTURE.md` dependency boundaries section to reflect realized ownership.
  - Updated `docs/ROADMAP.md` marking S6 complete.
- Added comprehensive test suite `tests/simplify-s6.test.js`:
  - Verifies that the real repository passes with 0 violations, 0 cycles, and 0 unresolved imports across 103 source files.
  - Verifies accurate owner mapping for all layers.
  - Uses isolated test fixtures to prove detection of forbidden edges (models -> backends, execution -> mcp, contracts -> storage).
  - Uses isolated test fixtures to prove detection of runtime cycles and type-only cycles.
  - Uses isolated test fixtures to prove detection of unresolved relative imports.
  - Proves legacy exemption tracking accepts individually specified edges with removal stages and rejects unrecorded edges.
  - Proves untracked source files are discovered and their forbidden edges/cycles flagged.
  - Proves unallowed computed require/import calls in source modules are rejected.
  - Proves runtime dependencies and cycles are accurately classified under ESM compiler options.
  - Proves arbitrary computed targets in src/index.ts mentioning setup.cjs are rejected unless matching the fixed AST path.join(__dirname, 'setup.cjs').
  - Proves discovery includes .mts and .cts modules and detects their forbidden edges and cycles.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (103 source files analyzed, 508 total edges, 344 runtime internal edges, 72 type-only internal edges, 1 computed call (0 violations), 0 legacy exemptions, 0 violations, 0 cycles, exit code 0).
- PASS: `node tests/run.cjs tests/simplify-s6.test.js` (12/12 tests pass, duration 14.0 s).
- PASS: `npm run build` (tsdown build completes cleanly in 419 ms).
- PASS: `npm test` (`node tests/run.cjs` full test suite: 425 tests: 422 pass, 0 fail, 3 skipped, duration 107.8 s, exit code 0).
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc generates `.artifacts/api-docs` with 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).

The original S6 implementation has a recorded independent review (codex
sol-6.1, VERDICT: READY). That historical verdict does not approve later changes.

### S6 enforcement follow-up (2026-10-09)

Base: f97ffeb6e552752cfc2d0fa9e16238e927c115b4 on refactor/simplify-001.
The owner requested fixes for two reproduced false passes: an external MCP SDK
import in contracts, and contracts -> constants.ts -> mcp/constants.ts.

- External imports now keep their identity for MCP/editor SDK ownership checks
  across all supported declaration forms. Node imports remain permitted.
- Indirect transport, SDK, editor and optional setup dependencies are checked
  across runtime and type edges; violations report the full dependency path.
- Unassigned modules no longer receive root composition privileges. Removed
  src/constants.ts and updated its remaining test consumer to mcp/constants.ts.
  The generated server icon remains an explicitly owned MCP asset.
- Discovery excludes deleted tracked files from the analyzed source count.
- Four new regression tests failed before the fix. After the fix, the scoped
  S6/S5/S2/MCP surface suite passed 39/39, with no skips (19.3 s).
- PASS: typecheck; check:dependencies (102 modules, 506 edges, 342 runtime
  internal edges, 72 type-only internal edges; no violations/cycles/exemptions);
  build; lint:docs; docs; npm pack --dry-run (123 packaged files).

- PASS: consumer smoke on Windows/Node v26.10.0, using a newly packed tarball
  (123 files), SHA-256
  266aad67bcf29c2fdbe85cbb534a360db823c82801f4d79edb2e33707c996462.
  Installed bin aliases, bundled SDK isolation, setup dispatch, fixture MCP
  turns/history and EOF passed. This is fixture evidence, not native CLI acceptance.
- PASS: final diff/content/local-link review and git diff --check.

Implementation commit: `af9f7d2`. Next action: independent review of this
follow-up before Git integration, then EXEC-001-T01 baseline under the detailed
[ROADMAP tasks](ROADMAP.md#exec-001-measured-preparation-and-complete-call-lifecycle).
No new independent approval, remote CI or native-client acceptance is established.
The subsequent plan edit requires content/local-link review and git diff --check;
it does not change runtime behavior or require repeating the preceding tests.

## EXEC-001-T01a call and wait map

Captured 2026-10-09 on branch `perf/exec-001-t01`.
Scope: complete call lifecycle inventory across `src/mcp/tools/consult.tool.ts`,
`src/mcp/tools/review.tool.ts`, `src/execution/controller.ts` and direct
routing/selection/consent/session callees.
Documentation-only card (Check: P).

| Phase | Function | Caller | Side effect | Timeout | Abort support |
| --- | --- | --- | --- | --- | --- |
| Tool input formatting (consult) | `handleConsult` | MCP dispatch (`src/server.ts`) | In-memory string formatting of task header, proposal, focus questions, target files | None | Passes `abortSignal` to `executeTask` |
| Review diff collection | `collectReviewInput` (`getReviewDiff`, `parseDiffStats`, `calculateSnapshotHash`) | `handleReview` in `src/mcp/tools/review.tool.ts` | Spawns child Git processes (`git status`, `git diff`, `git rev-parse`) | `GIT_COMMAND_TIMEOUT_MS` (5000 ms per Git invocation) | Forwarded via `abortSignal` to child process `execFile` |
| Review workspace assertion | `assertReviewWorkspace` | `handleReview` in `src/mcp/tools/review.tool.ts` | Spawns `git rev-parse --show-toplevel` validating working tree | `GIT_COMMAND_TIMEOUT_MS` (5000 ms) | Forwarded via `abortSignal` to `execFile` |
| Tool input formatting (review) | `handleReview` | MCP dispatch (`src/server.ts`) | Constructs State Envelope prompt template binding snapshot hash and diff | None | Passes `abortSignal` to `executeTask` |
| Task concurrency tracking | `executeTask` | `handleConsult` / `handleReview` | Adds/removes active task Promise in `activeExecutionTasks` Set | None | Handled in `finally` block |
| Nested-turn prevention | `assertNotNestedTurn` | `executeTaskInternal` in `src/execution/controller.ts` | Reads `COAGENT8_NESTED_TURN` environment variable; throws `ToolError('NESTED_TURN')` | None | Synchronous guard |
| Model identifier validation | `isValidModelIdentifier` | `executeTaskInternal` | In-memory regex validation of `args.model`; throws `ToolError('INPUT_LIMIT')` | None | Synchronous guard |
| Session validation | `getSession` | `executeTaskInternal` | Reads in-memory session map; validates workspace isolation; throws `ToolError('SESSION_INVALID')` | None | Synchronous check |
| Provider resolution | `resolveBackend` / `resolveBackendForModel` | `executeTaskInternal` | Probes CLI binaries (`probeCodexCli`, `probeClaudeCli`, `probeAgyCli`); reads cached probe from disk/memory; spawns CLI `--version` on probe cache miss | Probe execution timeout (2000–5000 ms per CLI probe; unverified for custom probe) | Checked via `abortSignal?.aborted` before/after; CLI child probes do not inherit caller signal (unverified) |
| Model selection | `selectModel` | `executeTaskInternal` | Matches model preferences and price constraints against backend probe capabilities | None | Checked via `abortSignal?.aborted` after selection |
| Catalog validation | `checkModelSelection` (`readModelCatalog`) | `executeTaskInternal` | Reads CLI catalog cache from disk/memory; throws `ToolError` on unsupported model or effort | None | Checked via `abortSignal?.aborted` after check |
| Pre-consent price check | `assertPriceLimit` (`readPrices`, `priceEvidence`, `checkPriceLimit`) | `executeTaskInternal` | Reads cached/stored pricing data; validates output price below ceiling; throws `ToolError('PRICE_LIMIT')` | Local read is synchronous; remote refresh fetch timeout is unverified | `abortSignal` not accepted by `readPrices` |
| User consent evaluation & prompt | `consentFor` -> `options.askConsent` | `executeTaskInternal` | Evaluates consent policy; awaits MCP elicitation from client/user; on user 'remember' writes config via `rememberApprovedModel`; throws `ToolError('POLICY_DENIED')` on refusal/unanswered | No controller timeout; wait duration depends on human user / client UI response (unbounded until client abort) | Checked via `abortSignal?.aborted` after user response |
| Post-consent price re-check | `assertPriceLimit` | `executeTaskInternal` | Re-verifies price limit against updated price list; throws `ToolError('PRICE_LIMIT')` | Same as pre-consent price check | Checked via `abortSignal?.aborted` |
| Session pruning & turn lease | `pruneExpiredSessions`, `acquireAndResolveSession` | `executeTaskInternal` | Cleans expired sessions; atomically acquires session lease and generates turn token; throws `ToolError('SESSION_BUSY')` on contention | None | Session acquisition is atomic/synchronous; `abortSignal` checked prior |
| History writer setup | `createHistoryWriter` | `executeTaskInternal` | Initializes append-only `HistoryWriter` stream and turn files | None | None |
| Cancellation registration | `activeSessionAborts.set` | `executeTaskInternal` | Registers session abort controller and settlement promise for `cancelSessionExecution` | Cancel wait timeout (5000 ms) | Listens to caller `abortSignal` and session cancel calls |
| Execution turn init | `writer.accept('turn_started')`, `writer.accept('user_message')` | `executeTaskInternal` | Appends turn header and user prompt to history buffer; flushes buffer | None | Handled inside try/catch (recorded to `historyError`) |
| Heartbeat & flush timers | `setInterval` (heartbeat, flush) | `executeTaskInternal` | Schedules progress heartbeat (5 s interval, triggers at >= 10 s elapsed) and history flush (250 ms interval) | Intervals cleared in `finally` | Handled in `finally` block |
| CLI adapter execution | `backend.adapter.execute` | `executeTaskInternal` | Spawns external CLI process (Codex app-server, Claude Code CLI, agy CLI); receives streamed events; bounds response at 1 MiB (`BufferLimitError`); redacts credentials | `args.timeout_ms` (passed to adapter as `options.timeoutMs`, defaulting to backend timeout e.g. 180 s / 300 s) | Wired to `cancelController.signal`; sends protocol interrupt / SIGTERM to child process tree |
| Session metadata update | `updateSession` | `executeTaskInternal` (post-execution bookkeeping) | Persists threadId, model, reasoningEffort, cliVersion to session storage; invalidates on `SESSION_INVALID` | None | Non-abortable finalization; errors caught and added to `warnings` |
| History finalization | `writer.accept('turn_finished')`, `writer.flush` | `executeTaskInternal` | Appends final turn status and output to history stream on disk | None | Non-abortable finalization; errors caught and added to `warnings` |
| Turn lease release | `releaseSessionTurn`, `activeSessionAborts.delete` | `executeTaskInternal` | Atomically releases turn lease token, unblocking subsequent turns; settles cancellation promise | None | Non-abortable cleanup; fail-closed `SESSION_INVALID` on release failure |
| Quota cooldown update | `recordQuotaCooldown` / `resetQuotaCooldown` | `executeTaskInternal` | Updates `.cooldown.json` under file lock on `RATE_LIMITED` error or resets cooldown on success | `withFileLock` lock timeout (2000 ms) | Non-abortable bookkeeping; errors caught and added to `warnings` |
| Post-turn review snapshot recheck | `options.verifyReviewSnapshot` (`collectReviewInput`, `assertReviewWorkspace`) | `executeTaskInternal` (review turns only) | Re-runs Git status and diff to detect workspace mutation during turn; sets `invalidatedReason` | `GIT_COMMAND_TIMEOUT_MS` (5000 ms per Git invocation) | Forwarded via `abortSignal` to `execFile` |
| State envelope evaluation | `evaluateStateEnvelopeGate` | `executeTaskInternal` (review turns only) | Parses review output string for State Envelope structure, verdict, coverage, and required checks | None | Pure synchronous string parsing |
| Tool result formatting | `formatExecutionResult` | `handleConsult` / `handleReview` | Formats final markdown result with metadata footer (`CoAgent8: ...`) | None | Synchronous formatting |

## EXEC-001-T01b baseline harness implementation

Implemented 2026-10-09 on branch `perf/exec-001-t01`.
Scope: fixture-only execution baseline harness in `tests/execution/baseline.test.js`.
Uses existing injection seams (`adapterRegistry` instrumented fixtures) to measure
observation counts (probes, catalog reads, launches) across plain cold/warm,
explicit model/effort, priced auto, continuation, review, and concurrent runs.
Unmeasured counters are recorded as `NOT_MEASURED`.

Observations and coverage:
- Plain cold: 1 probe, 1 launch; verifies cold runs probe and launch adapter.
- Plain warm: 0 probe delta (cached probe reused), 1 launch; verifies warm runs avoid reprobing.
- Explicit model/effort: verifies validated model/effort reaches adapter options.
- Priced auto: verifies highest-priced qualifying model below ceiling is selected (`gpt-5.6-luna` for ceiling 5 USD).
- Continuation: 1 launch, turn count advances to 2, native session ID propagated.
- Review: 1 launch, git diff verified in prompt, State Envelope evaluated to `READY`.
- Concurrent runs: 4 tasks execute concurrently, sharing a single coalesced probe (1 probe, 4 launches).
- Counters not yet observable before T02 (preparation, consent, acquisition, finalization phase durations, native launch overhead, client transport latency) are explicitly recorded as `NOT_MEASURED`.

Verification:
- PASS: `npm run typecheck` (0 errors)
- PASS: `npm run check:dependencies` (102 modules, 0 violations/cycles)
- PASS: `node tests/run.cjs tests/execution/baseline.test.js tests/environment.test.js` (9/9 pass, 0 fail, 4.1 s)
- PASS: `git diff --check`

## EXEC-001-T01c baseline measurement evidence

Captured 2026-10-09 on branch `perf/exec-001-t01`.
Scope: reproducible baseline measurement execution across 5 repetitions of the
T01b baseline test suite (`node tests/run.cjs tests/execution/baseline.test.js tests/environment.test.js`).

Source & Environment Identity:
- Platform: Windows 11 (`win32 x64`, OS release 10.0.26200)
- Node: `v26.10.0`
- Base Commit: `42e4cbd30f1d3d34e8ae8d388d57190f8d8e5a98`
- Tree SHA: `d9b25d46f122b62a56e2c19d10ccd993f13cbba5`
- Dirty Diff SHA-256: `21eba21b9637ab13d37c69006a3e8ab40696ff81d08b51039093cd2277bf4005`

Execution Measurements (5 consecutive runs, 9/9 tests passed on each run):
- Sample 1: Wall: 4301 ms | Test Runner: 3957.5 ms
- Sample 2: Wall: 5468 ms | Test Runner: 5096.7 ms
- Sample 3: Wall: 4547 ms | Test Runner: 3983.3 ms
- Sample 4: Wall: 6401 ms | Test Runner: 6061.2 ms
- Sample 5: Wall: 4926 ms | Test Runner: 4516.4 ms

Summary Statistics:
- Test Runner Duration: Median 4516.4 ms | Range [3957.5 ms .. 6061.2 ms]
- Wall Clock Duration: Median 4926 ms | Range [4301 ms .. 6401 ms]

Measured Observations per Scenario (actual counter deltas emitted by test harness):
| Scenario | Probes | Catalog Reads | Adapter Launches | Observed Parameters |
| --- | --- | --- | --- | --- |
| Plain Cold | 1 | 1 | 1 | Initial probe miss; catalog read; adapter launched |
| Plain Warm | 0 | 0 | 1 | Cached probe reused; 0 reprobes |
| Explicit Model/Effort | 1 | 0 | 1 | Fresh fixture probed; `model: gpt-6-sol`, `effort: high` |
| Priced Auto | 1 | 0 | 1 | Fresh fixture probed; ceiling 5 USD -> selected `gpt-5.6-luna` |
| Continuation | 0 | 0 | 1 | Session backend reused; turn 2, native ID `codex-native-1` |
| Review | 1 | 0 | 1 | Fresh fixture probed; diff inspected, verdict `READY` |
| Concurrent (4 tasks) | 1 | 1 | 4 | Coalesced probe and catalog read; 4 concurrent tasks |

Unmeasured Counters (retained as `NOT_MEASURED` until T02 phase instrumentation):
- `preparationDurationMs`: `NOT_MEASURED`
- `consentDurationMs`: `NOT_MEASURED`
- `acquisitionDurationMs`: `NOT_MEASURED`
- `finalizationDurationMs`: `NOT_MEASURED`
- `nativeProcessLaunchOverhead`: `NOT_MEASURED`
- `clientTransportLatency`: `NOT_MEASURED`

Verification:
- PASS: 5/5 repetitions exit code 0, 9/9 tests pass per run
- PASS: `npm run typecheck`
- PASS: `git diff --check`

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

## Historical runtime verification

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

## EXEC-001-T03 effective configuration with provenance

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: supply effective configuration with provenance across `src/config.ts`,
`src/config-overrides.ts`, `src/paths.ts`, `src/execution/routing.ts`,
`src/execution/selection.ts`, `src/execution/consent.ts`, `src/execution/controller.ts`,
`src/diagnostics/doctor.ts`, and `tests/config-snapshot.test.js`.

### Modules and ownership changes:
- `src/config.ts`:
  - Added `ConfigSnapshot`, `ConfigProvenance`, `SettingSource` types, and `getConfigFileOrigin()`.
  - Added `loadConfigSnapshot(configFile)` returning immutable request-local snapshot containing effective `CoAgent8Config`, granular per-setting source origin mapping (`default`, `file`, `editor`, `merged`), file stats, applied editor overrides, and non-secret 16-character SHA-256 `changeIdentity`.
  - Added `loadConfigSnapshotForDiagnostics(configFile)`: upon configuration errors, returns untouched defaults (`defaultConfig()`), records attempted unapplied editor settings separately in `editorOverridesAttempted`, sets `editorOverridesApplied: []`, and attributes all sources to `'default'`, ensuring truthful fallback diagnostic provenance.
  - Added `setConfigLoadObserver(observer)` for test and telemetry observation.
  - Preserved backward compatibility: `loadConfig()` returns `loadConfigSnapshot().config` and `loadConfigForDiagnostics()` returns `{ config: snapshot.config, error: snapshot.error }`.
- `src/config-overrides.ts`:
  - Added package documentation specifying scalar replacement vs list merging (`alwaysAsk`, `neverAsk`) precedence rules.
- `src/paths.ts`:
  - Documented `coagent8_DIR` environment precedence and provenance origin tracking.
- `src/execution/`:
  - Updated `resolveBackend`, `resolveBackendForModel`, `selectModel`, and `consentFor` to accept optional `config` (`ConfigSnapshot | CoAgent8Config`), eliminating duplicate configuration loading.
  - Updated `controller.ts` (`executeTaskInternal`): loads `configSnapshot = loadConfigSnapshot()` exactly once at preparation start and threads it through `resolveBackend`, `selectModel`, and `consentFor`.
- `src/diagnostics/doctor.ts`:
  - Added `DoctorConfigProvenance` interface exposing `path` (redacted via `redactDiagnostic`), `origin` (`custom-env` vs `default-path`), `existed`, `overrides`, `attemptedOverrides`, `changeIdentity`, and `error`.
  - Updated `DoctorReport` and `ModelReport` to include `configProvenance`.
  - Added clear recommendation notes distinguishing active custom paths (`coagent8_CONFIG`), active editor overrides, and inactive attempted overrides when configuration loading fails.
  - Retained strict byte bounds (`DOCTOR_SUMMARY_MAX_BYTES: 3900`) in `formatDoctorSummary` and `formatModelSummary`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (103 source files, 0 violations, 0 cycles).
- PASS: Scoped test suite: 86/86 pass (`tests/config-snapshot.test.js`, `tests/config.test.js`, `tests/config-editor-settings.test.js`, `tests/execution/routing.test.js`, `tests/execution/model-routing.test.js`, `tests/models/selection.test.js`, `tests/models/governance.test.js`, `tests/execution/price-limit.test.js`, `tests/diagnostics/doctor.test.js`, `tests/mcp/server.test.js`, `tests/mcp/result.test.js`, `tests/mcp/surface.test.js`, `tests/mcp/tools/doctor.test.js`, `tests/execution/baseline.test.js`).
- PASS: Single-load preparation regression: `tests/config-snapshot.test.js` verified preparation executes with exactly 1 snapshot load.
- PASS: `npm run lint:docs` (0 warnings, 0 errors).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings).
- PASS: `node tests/run.cjs` full test suite (474 tests: 471 pass, 0 fail, 3 skipped, duration 149.0 s, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review approval obtained via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_8a6da1da4c3e406e38687ab7`, Turn 2: `VERDICT: READY`).

## EXEC-001-T04 cohesive task preparation

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: extract cohesive task preparation into `src/execution/preparation.ts`, delegate lifecycle from `src/execution/controller.ts`, and add comprehensive unit test suite in `tests/execution/preparation.test.js`.

### Modules and ownership changes:
- `src/execution/preparation.ts` (new module, owner: `execution`):
  - Created `validateTaskContext(args, cwd, options)`: verifies nested turn guard (`assertNotNestedTurn`), pre-resolution cancellation, model identifier constraints (`isValidModelIdentifier`), session existence, workspace binding, provider switch refusal, and native continuation support (`threadId`).
  - Created `prepareTask(args, cwd, options)`: encapsulates single configuration snapshot loading/reuse, provider routing (`resolveBackend`, `resolveBackendForModel`), concrete model selection (`selectModel`), catalog capability validation (`checkModelSelection`), and user price ceiling enforcement (`assertPriceLimit`).
  - Defined typed `PreparedTask` lifecycle contract exposing `backend`, `model`, `reasoningEffort`, `previousSession`, `configSnapshot`, `outputPriceBelow`, `assertPriceLimit`, and `confirmConsent`.
  - Created `confirmTaskConsent(prepared, options)` / `prepared.confirmConsent(options)`: executes governance checks (`consentFor`), handles user approval/rejection (`askConsent`), persists remembered model consents (`rememberApprovedModel`), and re-asserts price ceilings immediately prior to session acquisition.
- `src/execution/controller.ts`:
  - Delegated `preparation` phase in `executeTaskInternal` to `prepareTask`, eliminating ~80 lines of inline routing, model selection, and validation boilerplate.
  - Delegated `consent` phase in `executeTaskInternal` to `prepared.confirmConsent`, isolating expensive model confirmation while keeping consent and lease acquisition explicit.
  - Re-exported universal execution types (`ExecutionRequest`, `ConsentPrompt`, `PreparedTask`, `PrepareTaskOptions`, `ConfirmConsentOptions`, `ConfirmConsentResult`) preserving backward compatibility for callers and MCP tool handlers.
- `tests/execution/preparation.test.js` (new test suite):
  - Added 6 granular unit tests covering invalid model identifier rejection, pre-aborted signal rejection, session/workspace/provider lock validation, single snapshot auto resolution, continuation parameter inheritance, and consent verification with price ceiling enforcement.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (104 source files analyzed, 520 dependency edges, 0 violations, 0 cycles).
- PASS: Scoped test suite: 66/66 pass (`tests/execution/preparation.test.js`, `tests/execution/routing.test.js`, `tests/execution/model-routing.test.js`, `tests/models/selection.test.js`, `tests/models/governance.test.js`, `tests/execution/price-limit.test.js`, `tests/sessions/session.test.js`, `tests/execution/controller-history.test.js`, `tests/execution/controller-cooldown.test.js`, `tests/execution/pipeline.test.js`, `tests/execution/baseline.test.js`).
- PASS: Dedicated preparation tests: 6/6 pass (`tests/execution/preparation.test.js`).
- PASS: `npm run lint:docs` (0 warnings, 0 errors).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings).
- PASS: `node tests/run.cjs` full test suite (480 tests: 477 pass, 0 fail, 3 skipped, duration 144.5 s, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_c1790e360e1da6ed293df519`): Reviewer confirmed `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 findings.

## EXEC-001-T05 reuse observations within preparation

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: reuse catalog and default-model observations across provider routing, selection, and consent in task preparation (`EXEC-001-T05a`, `T05b`), and verify invalidation conditions and baseline observation counters (`T05c`).

### Modules and ownership changes:
- `src/backends/probe-cache.ts`:
  - Added `ReadModelCatalogOptions` (`fresh`, `probe`, `catalog`) and `ReadObservedModelOptions` (`fresh`, `probe`).
  - `readModelCatalog`: accepts optional `probe` and pre-observed `catalog`. Reuses cached evidence if and only if backend, adapter list function, key (executable/config/env stamps), and TTL (< 5 min) match; explicit `fresh: true` forces re-reading.
  - `readObservedModel`: accepts optional `probe` to avoid redundant probe lookups and hashing.
- `src/execution/routing.ts`:
  - Added optional `catalog?: ModelCatalog` to `ResolvedBackend`.
  - `resolveBackendForModel`: captures `catalog` observed during provider capability qualification (`offers`) and attaches it to `ResolvedBackend`.
- `src/execution/selection.ts`:
  - Added optional `catalog?: ModelCatalog` to `selectModel` options.
  - Reuses catalog across initial resolution and priced fallback choices; validates catalog observation with `readModelCatalog` checking probe key, adapter, and TTL.
- `src/execution/consent.ts`:
  - Added `ConsentForOptions` supporting `defaultModel?: string | null`.
  - When pre-observed `defaultModel` is supplied, skips redundant `selectModel` invocation while preserving unknown-default handling (`null -> undefined`) and relative-price governance.
- `src/execution/preparation.ts`:
  - `prepareTask`:
    - Reuses catalog from provider routing (`backend.catalog`) in `selectModel`.
    - When selecting under price constraints (`choosing`), captures and reuses selection from provider eligibility.
    - Validates model and effort against catalog via `readModelCatalog` verifying probe key and TTL.
    - Pre-observes backend default model once during preparation, recording `defaultModel?: string | null` on `PreparedTask`.
    - Passes `defaultModel` to `consentFor` in `confirmConsent`.
- `tests/backends/probe-cache.test.js`:
  - Added tests for catalog cache invalidation: key changes (executable mtime, config changes, environment variable changes), fresh requests, replaced adapter functions, and memory misses falling back to stored `models.json`.
- `tests/execution/preparation.test.js`:
  - Added unit tests for catalog observation reuse, distinct requested vs default models, unknown-default handling, and dynamic price ceiling invalidation during pending consent.
- `tests/execution/baseline.test.js`:
  - Added assertions for `catalogReads` counters across cold, warm, explicit model, priced auto, and continuation runs.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (104 source files analyzed, 520 dependency edges, 0 violations, 0 cycles).
- PASS: Scoped test suite: 30/30 pass (`tests/execution/preparation.test.js`, `tests/backends/probe-cache.test.js`, `tests/execution/baseline.test.js`, `tests/models/selection.test.js`, `tests/models/governance.test.js`).
- PASS: Full test suite: 484 tests: 481 pass, 0 fail, 3 skipped, duration 108.2s, exit code 0 (`node tests/run.cjs`).
- PASS: `npm run lint:docs` (0 warnings, 0 errors).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_74de684872a8a8dc0d03f55c`, Turn 4: `COVERAGE: COMPLETE`, `VERDICT: READY`).

## EXEC-001-T06 guarantee finalization after resource acquisition

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: guaranteed finalization scope immediately after turn token acquisition (`EXEC-001-T06a`), isolation of metadata, archive, lease, and cooldown failures preserving Primary Task Supremacy and fail-closed lease invariant (`T06b`), and cancellation settlement guarantees for awaited processes and tasks (`T06c`).

### Modules and ownership changes:
- `src/execution/controller.ts`:
  - Entered guaranteed `try/finally` finalization scope immediately upon acquiring `session.turnToken` in `acquireAndResolveSession`.
  - Injected writer creation or registration failures release the turn lease, clear `activeSessionAborts`, and resolve `settled` waiters.
  - Isolated metadata update failures: records `Session update failed` warning, invalidates continuation (`continuationAvailable: false`), attempts session invalidation, and proceeds to remaining cleanup steps.
  - Isolated history archival failures: preserves valid user responses (Primary Task Supremacy), records `History not saved` warning, sets `historyAvailable: false`, and releases the turn lease cleanly.
  - Isolated lease release failures: enforces fail-closed behavior (`isError: true`, status `failed`, code `SESSION_INVALID`), invalidates continuation, and prevents READY review verdicts.
  - Bound quota cooldown to at most once per turn, capturing rate-limited errors even when overridden by subsequent lease release failures.
  - Enforced review snapshot check: failed or thrown snapshot rechecks set `reviewContext.invalidatedReason` and guarantee review verdict cannot yield READY.
  - Protected concurrent turn registrations: `finally` deletes `activeSessionAborts` entry if and only if the map entry still matches the current turn's `abortEntry` instance.
  - Succeeded cancellation and `waitForActiveExecutionTasks` guarantee all timers, listeners, processes, and session turn leases have fully settled.
- `src/execution/process.ts`:
  - `terminateProcessTree`: on Windows, unregisters the `exit` listener on timeout to prevent listener leaks.
  - `terminateAllProcesses`: uses `Promise.allSettled` across runs and processes.
  - `runCommand`: safely guards `child.stdin.end` and `close` handler process tree termination in `try/catch`.
- `src/storage/lock.ts`:
  - `inspectLease`: tolerates transient Windows file-sharing errors (`EPERM`, `EBUSY`) during concurrent contender inspections, allowing exponential jittered backoff loop to retry without throwing.
- `tests/execution/controller-finalization.test.js`:
  - Added 11 granular unit and integration tests covering acquisition failure recovery, registration failure recovery, metadata failure isolation, archive failure answer preservation, fail-closed lease failure, single-write cooldown, review snapshot recheck rejection, cancellation settlement during execution, cancellation settlement during finalization, replacement turn abort registration protection, and `waitForActiveExecutionTasks` settlement.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (104 source files analyzed, 520 dependency edges, 0 violations, 0 cycles).
- PASS: Scoped test suite: 91/91 pass (`tests/execution/controller-finalization.test.js`, `tests/execution/controller-history.test.js`, `tests/execution/controller-cooldown.test.js`, `tests/execution/controller-timing.test.js`, `tests/execution/process.test.js`, `tests/sessions/session.test.js`, `tests/storage/lock.test.js`, `tests/execution/pipeline.test.js`, `tests/execution/preparation.test.js`, `tests/mcp/tools/session.test.js`).
- PASS: Dedicated finalization tests: 11/11 pass (`tests/execution/controller-finalization.test.js`).
- PASS: Full test suite: 494 tests: 491 pass, 0 fail, 3 skipped, duration 137.8s, exit code 0 (`node tests/run.cjs`).
- PASS: `npm run lint:docs` (0 warnings, 0 errors).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_e77db3251b9304938fe5c8f6`, Turn 2: `COVERAGE: COMPLETE`, `VERDICT: READY`).

## EXEC-001-T07 complete-call budget contract

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: settle complete-call budget semantics in documentation (`EXEC-001-T07a`), implement neutral monotonic budget arithmetic primitive in `src/execution/runtime/budget.ts` (`T07b`), and centralize duplicated timeout defaults into contracts in `src/contracts/execution.ts` and `src/contracts/provider.ts` without altering adapter behavior (`T07c`).

### Settle timeout semantics (T07a):
1. **Start-before-Git**:
   - In tools like `review`, workspace inspection (`git rev-parse`, `git status`, `git diff`) precedes task preparation. Under the complete-call budget contract, the monotonic deadline begins at the very start of the tool invocation.
   - Time consumed by Git operations or workspace I/O is deducted from the complete-call budget, preventing stalled Git calls from granting extra model execution time.
2. **Consent-counted timing**:
   - Interactive user consent elicitation (bounded by `CONSENT_TIMEOUT_MS = 300_000`) elapses against the complete-call budget. The budget is not paused or reset while waiting for user approval.
   - If the user approval exceeds the remaining budget, the call times out fail-closed with `TIMEOUT`.
3. **Finite teardown allowance**:
   - Primary execution deadline is separated from total call deadline: `executionDeadlineMs = deadlineMs - teardownAllowanceMs`.
   - This reserves a dedicated finite window (`DEFAULT_TEARDOWN_GRACE_MS = 3_000` ms) for graceful child process tree termination (SIGINT->SIGKILL), session turn lease release, and history archiving before the absolute deadline.
   - Teardown allowance is separate, finite, and strictly bounded (`Math.min(teardownAllowanceMs, remainingTotalMs)`), ensuring secondary cleanup cannot hang indefinitely even if primary execution finishes instantly.
4. **Omitted, zero, and invalid timeout behavior**:
   - Omitted (`undefined` / `null`): defaults to `DEFAULT_EXECUTION_TIMEOUT_MS = 900_000` ms (15 minutes).
   - Zero, negative (`<= 0`), or non-finite (`NaN`, `Infinity`): fail closed immediately with error code `INPUT_LIMIT` (`Invalid deadline or buffer budget.`). No backend subprocess is spawned.
   - Out of bounds (`< 100` or `> 1_800_000`): rejected by MCP schema validation (`MIN_EXECUTION_TIMEOUT_MS` and `MAX_EXECUTION_TIMEOUT_MS`).
5. **Host cancellation vs timeout distinction**:
   - Host cancellation (`parentSignal: AbortSignal`): reports status `cancelled`, error code `ABORTED`, retryable `false`.
   - Monotonic deadline expiration: reports status `timed_out`, error code `TIMEOUT`, retryable `true`.
   - Precedence: whichever event occurs first establishes the terminal status and error code; subsequent triggers cannot flip the status.
6. **Migration of `timeout_ms`**:
   - External MCP tool schema parameter `timeout_ms` (snake_case) maps cleanly to canonical internal TypeScript contracts (`ExecutionOptions.timeoutMs`, `ExecutionBudget`, and `ExecutionRequest.timeout_ms`).
   - Public tool behavior remains backward compatible until full lifecycle propagation in T11.

### Modules and ownership changes (T07b, T07c):
- `src/contracts/execution.ts`:
  - Exported timeout constants: `DEFAULT_EXECUTION_TIMEOUT_MS = 900_000`, `DEFAULT_TEARDOWN_GRACE_MS = 3_000`, `MIN_EXECUTION_TIMEOUT_MS = 100`, `MAX_EXECUTION_TIMEOUT_MS = 1_800_000`.
  - Defined budget contracts: `BudgetStatus`, `ExecutionBudgetOptions`, and `ExecutionBudget`.
  - Updated `ExecutionOptions.timeoutMs` documentation referencing centralized default and T11 complete-call migration.
- `src/contracts/provider.ts`:
  - Exported provider discovery constants: `DEFAULT_PROBE_TIMEOUT_MS = 5_000` and `DEFAULT_MODEL_LIST_TIMEOUT_MS = 10_000`.
- `src/backends/types.ts`:
  - Re-exported provider timeout constants for backend consumers.
- `src/execution/process.ts`:
  - Bound `DEFAULT_TIMEOUT_MS` to `DEFAULT_EXECUTION_TIMEOUT_MS` and `INTERRUPT_GRACE_MS` to `DEFAULT_TEARDOWN_GRACE_MS`.
- `src/backends/codex/adapter.ts`, `src/backends/codex/models.ts`:
  - Bound probe command to `DEFAULT_PROBE_TIMEOUT_MS` and `MODEL_LIST_TIMEOUT_MS` to `DEFAULT_MODEL_LIST_TIMEOUT_MS`.
- `src/backends/claude/adapter.ts`:
  - Bound probe `--version` commands in `probe` and `runLocalUsage` to `DEFAULT_PROBE_TIMEOUT_MS`.
- `src/backends/agy/adapter.ts`:
  - Bound probe and `/usage` commands to `DEFAULT_PROBE_TIMEOUT_MS`, and `models` and `mcp list` commands to `DEFAULT_MODEL_LIST_TIMEOUT_MS`.
- `src/execution/runtime/budget.ts` (new module, owner: `execution`):
  - Implemented `createExecutionBudget(options?: ExecutionBudgetOptions): ExecutionBudget`.
  - Implemented `isValidBudgetDuration(val: unknown): val is number`.
  - Built immutable monotonic arithmetic with single deadline calculation, separate finite teardown allowance, non-resetting boundary checks, sticky host cancellation vs timeout discrimination, distinct execution and teardown abort signals, and safe idempotent resource disposal.
- `tests/execution/budget.test.js` (new test suite):
  - Added 19 unit tests covering parameter defaults, custom allowances, monotonic progression, exact execution and total boundaries, already-expired non-resetting behavior, separate finite teardown allowance, host cancellation vs timeout precedence, unobserved deadline precedence, caller cancellation during teardown allowance, pre-aborted signals, and safe disposal.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (105 source files analyzed, 523 dependency edges, 0 violations, 0 cycles).
- PASS: Scoped test suite: 75/75 pass (`tests/execution/budget.test.js`, `tests/execution/process.test.js`, `tests/backends/codex/adapter.test.js`, `tests/backends/claude/adapter.test.js`, `tests/backends/agy/adapter.test.js`).
- PASS: Dedicated budget tests: 19/19 pass (`tests/execution/budget.test.js`).
- PASS: Full test suite: 509 tests: 506 pass, 0 fail, 3 skipped, exit code 0 (`node tests/run.cjs`).
- PASS: `npm run lint:docs` (0 warnings, 0 errors).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_da0202ddbd686d31a839b346`, Turn 3: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues; independent tests NOT_RUN due to Windows sandbox ENOMEM).

## EXEC-001-T08a shared read and deadline context

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: define neutral deadline and cancellation context for backend observation reads (`BackendReadContext`), separate per-waiter deadline/cancellation ownership from shared-read inflight execution ownership, thread neutral context through adapter signatures and probe cache without claiming premature backend cancellation support, and establish an authoritative decision table for cancellation and inflight removal.

### Shared read and waiter ownership model:
1. **Per-waiter context (`BackendReadContext`)**:
   - Each caller/waiter provides an independent observation context containing `abortSignal?: AbortSignal`, `timeoutMs?: number`, and optional `budget?: ExecutionBudget`.
   - Distinct from turn-level `ExecutionOptions` (which controls prompt execution processes and session leases).
   - Aborting or timing out an individual waiter affects only that waiter's promise and does not abort other active waiters waiting for the same coalesced result.
2. **Shared-read ownership**:
   - The coalescing layer in `src/backends/probe-cache.ts` manages the underlying in-flight observation task.
   - The shared read is triggered on cache miss (or `fresh: true`).
   - Only when all active waiters unregister/abort does the shared-read coordinator trigger abort on the underlying operation.

### Decision table (cancellation & inflight removal):

| Event / Scenario | Active Waiters | Inflight Entry State | Responsible Entity | Action / Cancellation Mechanism | Inflight Removal Ownership |
| --- | --- | --- | --- | --- | --- |
| Waiter cancellation / timeout (`abortSignal` fires or waiter `timeoutMs` expires) | `> 1` (other waiters remain) | Active | Waiter / Caller | Waiter promise rejects immediately with `ABORTED` or `TIMEOUT`. Waiter unregisters from shared read. Shared read continues running uninterrupted. | Do NOT remove from `inflight`. The entry stays in `inflight` for remaining and newly joining waiters. |
| Last waiter cancellation / timeout (`abortSignal` fires or last waiter `timeoutMs` expires) | `0` (no waiters left) | Evicted immediately | Shared-Read Coordinator (`probe-cache`) | Coordinator triggers `sharedAbortController.abort()`, cancelling the underlying adapter operation / child process. | Coordinator removes key from `inflight` IMMEDIATELY upon 0 active waiters so new incoming callers do not join a doomed/aborted read. |
| Normal completion (underlying read succeeds) | `>= 1` | Active | Underlying Read Task & Coordinator | Result is saved to cache / stored models. All registered active waiters resolve with the result. | Coordinator's `finally` handler removes key from `inflight` ONLY IF `inflight.get(key) === thisEntry`. |
| Natural failure (underlying read throws/exits with error) | `>= 1` | Active | Underlying Read Task & Coordinator | All registered active waiters reject with the underlying error. Failure is not cached in persistent cache. | Coordinator's `finally` handler removes key from `inflight` ONLY IF `inflight.get(key) === thisEntry`. |
| Late settlement of an aborted or replaced read (underlying task finishes after eviction) | `0` | Replaced or absent | Late settling task | Cleans up any owned child resources in `finally`. Does NOT cache the result. | Checks `inflight.get(key) === thisEntry`. Because entry was already evicted or replaced, does NOT delete or disturb any newer entry in `inflight`. |
| Fresh read request (`options.fresh: true`) while a shared read is inflight | Any | Replaced with new read | New caller / Coordinator | `fresh: true` starts its own independent read (with its own context) and overwrites the `inflight` entry under that key so subsequent calls coalesce onto the fresh read. | When previous read settles, its identity check (`inflight.get(key) === oldEntry`) fails, ensuring the newer inflight entry remains intact. |

### Modules and interface changes:
- `src/contracts/execution.ts`:
  - Exported `BackendReadContext` interface with `abortSignal?: AbortSignal`, `timeoutMs?: number`, and `budget?: ExecutionBudget`.
- `src/backends/types.ts`:
  - Re-exported `BackendReadContext` and `type ReadContext = BackendReadContext`.
  - Updated `CliAdapter` interface: added optional `context?: BackendReadContext` to `probe`, `observeModel`, `inspectQuota`, `listModels`, and `inheritedTools`.
- `src/backends/probe-cache.ts`:
  - Exported `ProbeBackendOptions` interface with `fresh?: boolean` and `context?: BackendReadContext`.
  - Updated `ReadModelCatalogOptions` and `ReadObservedModelOptions` with `context?: BackendReadContext`.
  - Updated `coalesce` callback to accept `start: (context?: BackendReadContext) => Promise<T>` and forwarded `context` to adapter calls.
- `src/backends/codex/adapter.ts`, `src/backends/claude/adapter.ts`, `src/backends/agy/adapter.ts`:
  - Updated `probe`, `listModels`, `inspectQuota`, `observeModel`, and `inheritedTools` signatures to accept `context?: BackendReadContext` with backward-compatible defaults.
- `src/execution/routing.ts`:
  - Exported `ResolveBackendOptions` with `context?: BackendReadContext`.
  - Forwarded `options.context` to `probeBackend` and `readModelCatalog` across `resolveBackend` and `resolveBackendForModel`.
- `src/execution/selection.ts`:
  - Exported `SelectModelOptions` with `context?: BackendReadContext`.
  - Forwarded `options.context` to `readModelCatalog` and `readObservedModel`.
- `src/execution/preparation.ts`:
  - Updated `PrepareTaskOptions` with optional `budget?: ExecutionBudget`.
  - Created composite `readContext = (abortSignal || budget) ? { abortSignal, budget } : undefined` and forwarded to routing, model selection, and catalog verification.
- `tests/backends/probe-cache.test.js`:
  - Added dedicated regression test verifying that `probeBackend`, `readModelCatalog`, and `readObservedModel` forward `BackendReadContext` to adapters cleanly and preserve backward compatibility when omitted.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (105 source files analyzed, 524 dependency edges, 0 violations, 0 cycles).
- PASS: Scoped test suite: 77 tests (76 pass, 0 fail, 1 skipped (POSIX only), duration 20.4 s): `tests/backends/probe-cache.test.js`, `tests/execution/budget.test.js`, `tests/execution/preparation.test.js`, `tests/backends/codex/adapter.test.js`, `tests/backends/claude/adapter.test.js`, `tests/backends/agy/adapter.test.js`.
- PASS: Full test suite: 515 tests (512 pass, 0 fail, 3 skipped, duration 121.6 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_481dd949396808a8b5424c1d`, Turn 3: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues; independent tests NOT_RUN due to Windows sandbox ENOMEM).

## EXEC-001-T08b shared-read waiter ownership

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: implement shared-read waiter ownership in `src/backends/probe-cache.ts` and verify concurrent races and isolation in `tests/backends/probe-cache.test.js`.

### Implemented mechanisms:
1. **Per-waiter cancellation and timeout isolation**:
   - Each caller/waiter receives its own distinct Promise and lifecycle registration.
   - Waiter abort signals (`abortSignal`), timeouts (`timeoutMs`), and budgets (`budget`) are evaluated per waiter.
   - When an individual waiter cancels or times out, only that waiter's promise is detached and rejected (with `ToolError('ABORTED')` or `ToolError('TIMEOUT')`). Other active waiters waiting for the shared task continue uninterrupted.
   - The shared underlying task receives strictly coordinator-owned context (`sharedContext = { abortSignal: newEntry.abortController.signal }`); caller timeouts and budgets are not forwarded to the shared task.
2. **Last-waiter abort & immediate inflight eviction**:
   - The shared coordinator tracks active registered waiters in a Set.
   - When the last active waiter unregisters/cancels (active waiters count drops to 0), the coordinator triggers `abort()` on the shared `AbortController` and immediately evicts the entry from `inflight`.
   - New incoming callers arriving after last-waiter cancellation start a fresh read and never coalesce onto an aborted/dying task.
3. **Late settlement & replacement race protection**:
   - In `finally`, `inflight.delete(key)` is gated strictly by identity check: `inflight.get(key) === entry`.
   - A late-settling read (whether aborted or replaced by a `fresh: true` read) never evicts or disturbs a newer inflight entry.
   - Fresh reads (`fresh: true`) overwrite `inflight` immediately; subsequent calls coalesce onto the fresh read.
4. **Cache poisoning prevention on late settlement**:
   - In `probeBackend`, `readModelCatalog`, and `readObservedModel`, cache updates are guarded by `isCurrentInflight(key, readContext)` and `!readContext.abortSignal.aborted`.
   - Replaced or aborted reads never write obsolete results into memory or persistent model storage.
5. **Deterministic resource cleanup**:
   - Waiter cleanup guaranteed on settlement or detachment: timeout timers cleared via `clearTimeout` and signal event listeners removed via `removeEventListener`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode).
- PASS: `npm run check:dependencies` (105 source files analyzed, 524 dependency edges, 0 violations, 0 cycles).
- PASS: Scoped test suite: 11 tests (11 pass, duration 1.0 s): `tests/backends/probe-cache.test.js`.
- PASS: Full test suite: 520 tests (517 pass, 0 fail, 3 skipped, duration 111.9 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_969dbd07eb423f8cbf9d604a`, Turn 3: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues; independent tests NOT_RUN due to Windows sandbox ENOMEM).

## EXEC-001-T08c bound Codex reads

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: bound Codex observation reads (`probe`, `listModels`, `inspectQuota`) by propagating `BackendReadContext` and `abortSignal` through `src/backends/codex/adapter.ts`, `src/backends/codex/models.ts`, and regression tests in `tests/backends/codex/adapter.test.js`.

### Implemented mechanisms:
1. **Context propagation & signal resolution**:
   - `probe(context?: BackendReadContext)` in `src/backends/codex/adapter.ts` accepts `BackendReadContext`.
   - `listModels(probe, context)` and `inspectQuota(probe, context)` on `codexAdapter` forward `context` to `listCodexModels` and `readCodexRateLimits`.
   - `listCodexModels(command, acceptedEfforts, context?: BackendReadContext)` and `readCodexRateLimits(command, context?: BackendReadContext)` in `src/backends/codex/models.ts` accept `BackendReadContext`.
   - Effective abort signal is resolved via `context?.abortSignal ?? context?.budget?.executionSignal`, ensuring composite budgets provide fallback cancellation.
2. **Pre-flight cancellation and budget deadline checks**:
   - Before launching child processes, `probe`, `listCodexModels`, and `readCodexRateLimits` verify `abortSignal?.aborted` (rejecting immediately with `ToolError('ABORTED')`) and `context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()` (rejecting with `ToolError('TIMEOUT')`).
   - Pre-aborted queries skip process execution entirely, leaving 0 active processes.
3. **Subprocess supervisor bounding**:
   - Forwarded `abortSignal` to `runCommand` in `probe` (`codex --version`), `listCodexModels` (`codex app-server`), and `readCodexRateLimits` (`codex app-server`).
   - When aborted mid-flight, `runCommand` cancels the process, interrupts stdin protocol sessions, triggers `terminateProcessTree(child)` on Windows and POSIX, and resolves with `status: 'cancelled'` and `error: { code: 'ABORTED' }`.
   - Post-run assertions verify cancellation status and reject deterministically with `ToolError('ABORTED')`.
4. **Guaranteed handle & channel cleanup**:
   - In `models.ts`, JSON-RPC session channel interactions are enclosed in `try { ... } finally { channel?.close(); }`, guaranteeing stdin closure and release under any outcome.
   - Fixture `tests/fixtures/codex-cli/codex.cjs` supports simulated hang modes (`hang-probe`, `hang-models`, `hang-limits`) to verify clean cancellation and handle release.
5. **Deterministic test coverage in `tests/backends/codex/adapter.test.js`**:
   - Verified backward compatibility when `context` is omitted.
   - Verified pre-aborted signal rejection (`ToolError` with code `ABORTED`) with 0 spawned processes.
   - Verified pre-expired budget rejection (`ToolError` with code `TIMEOUT`) with 0 spawned processes.
   - Verified stalled probe cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled catalog read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled quota read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 525 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 24 tests (24 pass, 0 fail, duration 12.4 s, exit code 0): `tests/backends/codex/adapter.test.js`, `tests/backends/probe-cache.test.js`.
- PASS: Full test suite: 522 tests (519 pass, 0 fail, 3 skipped, duration 167.7 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_49b61bc0a5e28bab847e0b4d`, Turn 2: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues; independent tests NOT_RUN due to Windows sandbox ENOMEM).

## EXEC-001-T08d bound Claude reads

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: bound Claude observation reads (`probe`, `observeModel`, `listModels`, `inspectQuota`) by propagating `BackendReadContext` and `abortSignal` through `src/backends/claude/adapter.ts`, bounding subprocess timeouts, ensuring deterministic handle cleanup on aborted/stalled reads, and adding regression coverage in `tests/backends/claude/adapter.test.js` and `tests/fixtures/claude-cli/claude.cjs`.

### Implemented mechanisms:
1. **Context propagation & signal resolution**:
   - `probe(context?: BackendReadContext)` in `src/backends/claude/adapter.ts` accepts `BackendReadContext`.
   - `observeModel(requested, probe, context)` and `inspectQuota(probe, context)` on `claudeAdapter` accept and forward `context` to `runLocalUsage`.
   - `runLocalUsage(model, probe, context)` accepts `context` and bounds both `--version` and `/usage` runs.
   - `listModels(probe, context)` accepts `context` and bounds the restricted stream-json session.
   - Effective abort signal is resolved via `context?.abortSignal ?? context?.budget?.executionSignal`, providing fallback cancellation when composite budgets expire.
2. **Pre-flight cancellation and budget deadline checks**:
   - Before launching child processes, `probe`, `runLocalUsage`, `observeModel`, `inspectQuota`, and `listModels` verify `abortSignal?.aborted` (rejecting immediately with `ToolError('ABORTED')`) and `context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()` (rejecting with `ToolError('TIMEOUT')`).
   - Pre-aborted queries skip process execution entirely, leaving 0 active processes.
3. **Bounded subprocess timeouts & post-run budget attribution**:
   - Added helper `boundReadTimeout(context, defaultMs)` which caps `context.timeoutMs` with `Math.min(context.timeoutMs, defaultMs)`. Applied across all 5 command launches: probe (`--version`, `auth status`), local usage (`--version`, `/usage`), and catalog (`initialize`).
   - Cancellation checks verify budget expiration (`isTimedOut()` or `isExecutionExpired()`) and attribute timeout explicitly to `ToolError('TIMEOUT')`.
   - Post-run budget expiration checks are guarded by `res.status !== 'completed'`, ensuring completed reads preserve their results.
4. **Guaranteed handle & channel cleanup**:
   - In `listModels`, stream-json session channel interactions are enclosed in `try { ... } finally { channel?.close(); }`, guaranteeing stdin channel closure under any outcome.
   - Fixture `tests/fixtures/claude-cli/claude.cjs` supports simulated hang modes (`hang-probe`, `hang-auth`, `hang-usage`, `hang-catalog`, `hang-after-channel-close`) to verify clean cancellation and handle release.
5. **Deterministic test coverage in `tests/backends/claude/adapter.test.js`**:
   - Verified backward compatibility when `context` is omitted.
   - Verified pre-aborted signal rejection (`ToolError` with code `ABORTED`) with 0 spawned processes across probe, observe, catalog, and quota.
   - Verified pre-expired budget rejection (`ToolError` with code `TIMEOUT`) with 0 spawned processes across probe, observe, catalog, and quota.
   - Verified stalled probe cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled catalog read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled observeModel cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled quota read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified fallback cancellation via `context.budget.executionSignal`.
   - Verified stalled probe, quota, and catalog termination via `timeoutMs`, settling safely with 0 active processes.
   - Verified stalled catalog hanging on EOF after `channel.close()` safely terminates on timeout with 0 active processes.
   - Verified stalled probe ended by budget expiration during run attributes deterministically to `ToolError('TIMEOUT')` with 0 active processes.
   - Replaced fixed sleep with deterministic `waitForActiveProcess()` polling helper to eliminate test flakiness.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (106 source files analyzed, 538 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 24 tests (24 pass, 0 fail, exit code 0): `tests/backends/claude/adapter.test.js` (13 pass), `tests/backends/probe-cache.test.js` (11 pass).
- PASS: Full test suite: 523 tests (520 pass, 0 fail, 3 skipped, duration 154.1 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `claude`, model `claude-sonnet-5-5`, session `syn_sess_ec5f8854d53195c6c7788566`, Turn 2: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues; independent tests NOT_RUN due to read-only sandbox).

## EXEC-001-T08e bound agy reads

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: bound agy (Antigravity/Gemini) observation reads (`probe`, `inspectQuota`, `listModels`, `inheritedTools`) by propagating `BackendReadContext` and `abortSignal` through `src/backends/agy/adapter.ts`, bounding subprocess timeouts, ensuring deterministic handle and process cleanup on aborted/stalled reads, and adding regression coverage in `tests/backends/agy/adapter.test.js` and `tests/fixtures/agy-cli/agy.cjs`.

### Implemented mechanisms:
1. **Context propagation & signal resolution**:
   - `probe(context?: BackendReadContext)` in `src/backends/agy/adapter.ts` accepts `BackendReadContext`.
   - `inspectQuota(probe, context)` on `agyAdapter` accepts and bounds the sandboxed `/usage` query.
   - `listModels(probe, context)` accepts and bounds the `agy models` catalog query.
   - `inheritedTools(context)` accepts and bounds the `agy mcp list` query.
   - Centralized abort signal resolution helper `effectiveAbortSignal(context)` resolves `context?.abortSignal ?? context?.budget?.executionSignal`.
2. **Pre-flight cancellation and budget deadline checks**:
   - Added `checkPreflight(context, operation)` verifying `abortSignal?.aborted` (rejecting immediately with `ToolError('ABORTED')`) and `context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()` (rejecting with `ToolError('TIMEOUT')`).
   - Pre-aborted queries skip process execution entirely, leaving 0 active processes.
3. **Bounded subprocess timeouts & post-run budget attribution**:
   - Added helper `boundReadTimeout(context, defaultMs)` which caps `context.timeoutMs` with `Math.min(context.timeoutMs, defaultMs)`. Applied across all 4 command launches: probe (`--version`), quota (`/usage`), catalog (`models`), and inherited tools (`mcp list`).
   - Added `checkPostRun(res, context, operation)` verifying budget expiration (`isTimedOut()` or `isExecutionExpired()`) on cancellation, attributing timeout explicitly to `ToolError('TIMEOUT')`, or else `ToolError('ABORTED')`.
   - Timed-out probe queries cleanly set `installed: false` and preserve `authStatus: 'unknown'`, never misclassifying timeout as `unauthenticated`.
   - Quota queries retain `--sandbox` under all outcomes.
4. **Fixture hang modes & process lifecycle safety**:
   - Extended `tests/fixtures/agy-cli/agy.cjs` with hang simulation modes (`hang-probe`, `hang-quota` / `hang-usage`, `hang-models` / `hang-catalog`, `hang-mcp` / `hang-tools`) to verify clean cancellation and handle release across all 4 read paths.
5. **Deterministic test coverage in `tests/backends/agy/adapter.test.js`**:
   - Verified backward compatibility when `context` is omitted across all 4 operations.
   - Verified pre-aborted signal rejection (`ToolError` with code `ABORTED`) with 0 spawned processes across probe, quota, catalog, and inherited tools.
   - Verified pre-expired budget rejection (`ToolError` with code `TIMEOUT`) with 0 spawned processes across probe, quota, catalog, and inherited tools.
   - Verified stalled probe cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled quota read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled catalog read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified stalled inherited tools read cancellation via `abortSignal`, releasing processes (`activeProcesses.size === 0`) and rejecting with `ABORTED`.
   - Verified fallback cancellation via `context.budget.executionSignal`.
   - Verified stalled probe, quota, catalog, and inherited tools termination via `timeoutMs`, settling safely with 0 active processes.
   - Verified stalled probe ended by budget expiration during run attributes deterministically to `ToolError('TIMEOUT')` with 0 active processes.
   - Verified stalled quota, catalog, and inherited tools ended by budget expiration during run attribute to `ToolError('TIMEOUT')` with 0 active processes.
   - Uses deterministic `waitForActiveProcess()` polling helper instead of fixed timers.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 525 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 39 tests (38 pass, 1 skipped POSIX-only, 0 fail, exit code 0): `tests/backends/agy/adapter.test.js` (27 pass, 1 skipped), `tests/backends/probe-cache.test.js` (11 pass).
- PASS: Full test suite: 524 tests (521 pass, 0 fail, 3 skipped, duration 184.8 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers).
- Independent review audit conducted via MCP `coagent8` `review` (backend `claude`, model `claude-sonnet-5-5`, session `syn_sess_ee0682d203229ba6a3a802ae`, Turn 3: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2/P3 issues; independent tests NOT_RUN due to read-only sandbox).

## EXEC-001-T08f: bound price fetches and close shared-read races

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: bound model price fetches and close shared-read concurrency races across `src/models/prices.ts`, `src/models/store.ts`, `src/backends/probe-cache.ts`, and `src/backends/availability.ts`, with comprehensive unit tests in `tests/models/prices.test.js` and `tests/backends/probe-cache.test.js`.

### Implemented mechanisms:
1. **Context propagation & pre-flight checks**:
   - `readPrices({ models, current, refresh, fresh, context })` and `refreshPrices(models, context)` accept optional `BackendReadContext` (`abortSignal`, `budget`, `timeoutMs`).
   - Pre-flight validation checks `abortSignal?.aborted` (rejecting immediately with `ToolError('ABORTED')`), and `context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()` or non-positive `timeoutMs` (rejecting immediately with `ToolError('TIMEOUT')`) without initiating network or storage I/O.
   - Timeout bounds implemented with `boundReadTimeout(context, defaultMs)` via `Math.min`.
   - `readSource` bounds HTTP fetch with `FETCH_TIMEOUT_MS` (10s) and combines caller signal with timeout signal via `AbortSignal.any`.
2. **Per-waiter cancellation & timeout isolation**:
   - Multiple concurrent callers waiting on an in-flight read are tracked in `PriceInflightEntry.waiters`.
   - Detaching/cancelling one waiter (via `abortSignal`, `budget.executionSignal`, or `timeoutMs`) rejects that waiter's promise without cancelling the shared coordinator or affecting concurrent waiters.
3. **Last-waiter coordinator cancellation & eviction**:
   - When the last active waiter detaches from an in-flight read, `targetEntry.abortController.abort(error)` is invoked and the entry is immediately evicted from `activeInflight`, releasing ongoing HTTP resources.
4. **Late settlement & cache poisoning protection**:
   - If an in-flight read is superseded (e.g. by `fresh: true`) or aborted, `isCurrentPriceInflight(entry, context)` prevents late completion from writing to disk.
   - `src/models/store.ts` (`recordPrices`) guards against overwriting newer disk prices (`store.prices.fetchedAt > prices.fetchedAt`).
   - Incremental entry IDs (`latestInflightId`) ensure that superseded/aborted reads never overwrite the 5-minute `failedAt` retry cooldown.
   - Aborted or timed-out reads (`ToolError` with ABORTED or TIMEOUT) do not set `failedAt`, allowing subsequent retries to proceed immediately without cooldown.
   - Successful reads that finished after last-waiter abort do not clear earlier genuine failure cooldowns.
5. **Joiner follow-up reads & coalescing**:
   - If a caller joins an in-flight read whose completed price list does not cover the caller's models, it automatically triggers a follow-up coalesced read (`sharedRefresh(models, context, false)`).
   - In `readPrices`, `options.refresh` (doctor) participates in coalescing and honors retry cooldown, while `options.fresh` initiates an independent fresh read.
6. **Availability & probe-cache integration**:
   - `inspectQuotas` in `src/backends/availability.ts` accepts `BackendReadContext`, enforces pre-flight checks, and routes probe queries through `probeBackend(id, { fresh: forceRefresh, context: options.context })`.
   - `selectSmartQuotaBackend` forwards `options.context` to `inspectQuotas`.
   - `onBudgetAbort` in `src/backends/probe-cache.ts` properly detects `isExecutionExpired() || isTimedOut()`, mapping deadline expiration deterministically to `ToolError('TIMEOUT')`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 527 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 34 tests (34 pass, 0 fail, exit code 0): `tests/models/prices.test.js` (20 pass), `tests/backends/probe-cache.test.js` (14 pass).
- PASS: Full test suite: 541 tests (538 pass, 0 fail, 3 skipped, duration 174.6 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audit conducted via MCP `coagent8` `review` (backend `claude`, model `claude-sonnet-5-5`, session `syn_sess_7ce0059e742deb4a45cbc367`, Turn 4: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T09a: bound review Git work

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: bound review Git operations and child process lifecycle across `src/workspace/git.ts`, `src/review/input.ts`, `src/review/index.ts`, `src/mcp/tools/review.tool.ts`, `src/execution/controller.ts`, and `src/execution/preparation.ts`, with comprehensive unit and integration tests in `tests/workspace/git.test.js` and `tests/mcp/tools/review.test.js`.

### Implemented mechanisms:
1. **Context & Budget Propagation**:
   - `runGit(args, cwd, abortSignalOrContext, timeoutMs, onTruncated, explicitContext)` accepts both `AbortSignal` and `BackendReadContext`.
   - `collectGitScope`, `snapshotId`, `assertReviewWorkspace`, and `collectReviewInput` accept optional `BackendReadContext` and propagate it through every Git command, diff collection, and hash computation.
   - `boundGitTimeout(context, defaultMs)` clamps individual command deadlines to remaining execution budget (`budget.remainingExecutionMs()`) or caller `timeoutMs`.
   - `effectiveSignal` unifies caller `abortSignal`, `context.abortSignal`, and `budget.executionSignal` via `combineSignals`.
2. **Process Lifecycle & Cleanup**:
   - `runCommand`'s underlying supervisor guarantees that on child exit/close, `terminateProcessTree(child, signalGrace)` is awaited and the process is deleted from `activeProcesses` before resolving.
   - Pre-flight validation via `assertNotExpired(effectiveSignal, context, phase, true)` rejects before launch if the signal was aborted (`ToolError('ABORTED')`) or budget expired / deadline non-positive (`ToolError('TIMEOUT')`), spawning 0 subprocesses.
   - In-flight aborts or budget expirations terminate the child process tree and reject with `ToolError('ABORTED')` or `ToolError('TIMEOUT')`.
   - In `collectGitScope`, the untracked file traversal checks `assertNotExpired` on each iteration to prevent runaway loops.
3. **Integrity & Verdict Protection (Stalled Git / Partial Input / Failed Recheck)**:
   - In `collectGitScope` and `snapshotId`, `ABORTED` and `TIMEOUT` errors are rethrown immediately, preventing erroneous fallbacks to "no HEAD" or "no-commit".
   - `snapshotId`'s no-commit fallback delegates directly to `runGit(['rev-parse', '--git-dir'], ...)` preserving error typing and timeout bounds.
   - During review recheck (`verifyReviewSnapshot`), `collectReviewInput` and `assertReviewWorkspace` run with the bound context; any failure (timeout, aborted signal, dirty/foreign workspace, or changed snapshot digest) populates `snapshotError`, setting `reviewContext.invalidatedReason`.
   - `evaluateStateEnvelopeGate` evaluates `context.invalidatedReason` and `!context.inputComplete` deterministically to `VERDICT: BLOCKED`, overriding any reported `READY` from model answers.
   - Foreign-tree rejection (`assertReviewWorkspace`) remains strictly enforced with `ToolError('POLICY_DENIED')`.
4. **Backward Compatibility**:
   - `normalizeSignalAndContext` cleanly handles callers passing `AbortSignal | null`, `BackendReadContext`, or both. Legacy callers without context continue to execute with default bounds.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 528 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 16 tests (16 pass, 0 fail, exit code 0): `tests/workspace/git.test.js` (15 pass), `tests/workspace/git-fixture.test.js` (1 pass).
- PASS: Full test suite: 556 tests (553 pass, 0 fail, 3 skipped, duration 214.2 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audit conducted via MCP `coagent8` `review` (backend `claude`, model `claude-sonnet-5-5`, session `syn_sess_0d363c789ba2df6e39ebe9c0`, Turn 3: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2/P3 issues).

## EXEC-001-T09b: cancel lock waiters safely

Implemented 2026-10-09 on branch `perf/exec-001`.
Scope: safe cancellation of lock waiters across in-process FIFO queues and on-disk lease contention backoff in `src/storage/lock.ts`, with comprehensive concurrency and regression tests in `tests/storage/lock.test.js`.

### Implemented mechanisms:
1. **Polymorphic signature & context support**:
   - `withFileLock(resource, fn, timeoutMsOrOptions)` accepts numeric timeout (`number`), direct `AbortSignal`, options object (`FileLockOptions`), or `BackendReadContext`, retaining 100% backward compatibility for legacy and uncontended callers (including `timeoutMs: 0`).
   - Signal normalization merges `options.abortSignal`, `context.abortSignal`, and monotonic `budget.executionSignal` via `combineSignals`.
   - `parseFileLockOptions` clamps effective acquisition timeout to monotonic `budget.remainingExecutionMs()` when an active budget is attached.
2. **Pre-flight cancellation**:
   - Immediately rejects with `ToolError('ABORTED')` if `effectiveSignal.aborted` or `budget.isCallerAborted() || budget.isExecutionExpired() || budget.isTimedOut()` before touching `inProcessLocks` or performing any filesystem operations.
3. **In-process FIFO queue progress & cancellation**:
   - Raced promise in `Promise.race([prev, timer, abortPromise])` listens to `effectiveSignal` abort events and cleans up listeners deterministically in `finally`.
   - When a queued waiter (e.g. middle of three waiters) is cancelled or times out, its critical section does not run and it immediately releases its own in-process gate (`releaseInProcess()`).
   - Because `chainedLock` chains off the previous waiter (`prev.then(() => currentGate, () => currentGate)`), subsequent queued waiters only proceed after the genuine predecessor finishes, strictly preserving FIFO progress without stranding the third waiter.
   - Tail cleanup in `inProcessLocks` is preserved and executed via `chainedLock.finally` once earlier turns settle.
4. **On-disk lease contention backoff cancellation**:
   - Backoff wait in `delay(waitTime, undefined, { signal: effectiveSignal })` is interrupted immediately upon abort rather than sleeping out the full backoff duration.
   - Contention loop continuously checks signal and budget status on every iteration before attempting `publishLease` or `reclaimStaleLease`.
5. **Token ownership, lease renewal, and isolation**:
   - Cancelled or timed-out contenders have `owned = false` and never execute `fs.rm` or interfere with foreign leases on disk.
   - An active holder starts lease renewal (`LEASE_RENEW_MS = 2000`) and removes its lease on critical section exit only after verifying that the lease token matches `myToken`.
   - If cancellation fires immediately after `publishLease` succeeds, `owned = true` guarantees token-verified lease deletion in `finally`, leaving no orphaned lease files.
6. **Error distinction**:
   - Lock acquisition expiration throws `LockTimeoutError`, whereas external signal cancellation or budget expiration throws `ToolError('ABORTED')`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 530 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 17 tests (17 pass, 0 fail, exit code 0): `tests/storage/lock.test.js`.
- PASS: Full test suite: 563 tests (560 pass, 0 fail, 3 skipped, duration 154.1 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audit conducted via MCP `coagent8` `review` (backend `claude`, model `claude-sonnet-5-5`, session `syn_sess_e823e6e0bc8ff25dab630111`, Turn 4: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T09c: stop session acquisition after expiry

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: stop session acquisition after expiry or cancellation across `src/sessions/session.ts`, `src/execution/controller.ts`, `src/sessions/history/writer.ts`, and `src/sessions/history/retention.ts`, verified with concurrency and lifecycle tests in `tests/sessions/session.test.js` and `tests/execution/controller-finalization.test.js`.

### Implemented mechanisms:
1. **Polymorphic context and budget propagation**:
   - `acquireAndResolveSession`, `acquireSessionTurn`, and `withSessionLock` accept optional timeout (`number`), direct `AbortSignal`, options object (`FileLockOptions`), or `BackendReadContext`, maintaining 100% backward compatibility for existing callers without options.
   - `parseSessionOptions` extracts `budget` and computes `effectiveSignal` combining caller signals with `budget.executionSignal`.
   - Shared helpers `isBudgetExpired`, `isSessionExpired`, and `assertSessionNotExpired` unify monotonic budget expiration (`isExecutionExpired() || isTimedOut() || remainingExecutionMs() <= 0`) and signal cancellation checks across `session.ts` and `controller.ts:assertSessionContextNotExpired`.
2. **Pre-flight & synchronous boundary checks**:
   - Immediate rejection with `ToolError('ABORTED')` or `ToolError('TIMEOUT')` before resolving or creating new session files on disk.
   - Additional pre-flight checks inside `acquireSessionTurn` before lock acquisition and within the locked critical section before record mutation.
3. **Uninterruptible atomic I/O documentation & rollback guarantees**:
   - Atomic file writes (`atomicWrite` via `fs.rename`) represent uninterruptible OS operations.
   - If cancellation or budget expiration occurs across a write boundary immediately after saving running turn state, locked rollback to `idle` state is executed: `turnToken` is nulled, `activePid` and `activeTurnAt` are cleared, `turnCount` is decremented, and in-process tracking (`ownedTurns.delete(handle)`) is cleaned up.
   - Newly initialized empty session files from `acquireAndResolveSession` are unlinked upon abort or failure, leaving no orphaned session files on disk.
4. **Fault isolation and rollback failure resilience**:
   - If rollback file write fails due to simulated or unexpected OS disk error (e.g. `EIO`), a warning is logged to stderr, memory state is cleaned up, and the cancellation/expiry `ToolError` is still surfaced without hanging.
5. **Lock contention timeout vs cancellation contract**:
   - Contention timeout under ordinary options without cancellation returns `{ ok: false, error }`, allowing `controller.ts` to map it to `SESSION_BUSY`.
   - Aborting contenders or expiring execution budgets reject with typed `ToolError('ABORTED')` or `ToolError('TIMEOUT')` without corrupting active turns or stranding subsequent contenders.
6. **History reservation bounding**:
   - History writer initialization (`createHistoryWriter`) bounds initial pruning and header capacity reservation (`initLockOptions`), preventing leaked byte reservations when aborted before execution.
   - Subsequent event appends and terminal `turn_finished` flushes run unbounded to uphold Primary Task Supremacy.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 532 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 31 tests (31 pass, 0 fail, exit code 0): `node tests/run.cjs tests/sessions/session.test.js tests/execution/controller-finalization.test.js`.
- PASS: Full test suite: 569 tests (566 pass, 0 fail, 3 skipped, duration 139.1 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audits conducted via MCP `coagent8` `review` (backend `claude`, model `claude-sonnet-5-5`, session `syn_sess_15716fab30909ee18968f610`, Rounds 6, 8, 9: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T10a: cancel a pending approval

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: cancel pending approval and bind consent confirmation to the monotonic execution budget and request identity across `src/execution/preparation.ts`, `src/execution/controller.ts`, `src/mcp/server.ts`, and `src/storage/lock.ts`, verified with comprehensive unit and integration tests in `tests/execution/controller-consent.test.js`.

### Implemented mechanisms:
1. **Dynamic monotonic budget binding & elicitation timeout**:
   - `server.elicitInput` in `src/mcp/server.ts:consentPrompt` calculates prompt timeout dynamically from `effectiveBudget.remainingExecutionMs()`, falling back to `CONSENT_TIMEOUT_MS = 5 * 60 * 1000` only when no budget is attached.
   - Pre-flight checks reject immediately with typed `ToolError('TIMEOUT')` or `ToolError('ABORTED')` if the budget deadline or caller abort signal expired before elicitation starts.
2. **Pending callback race and timeout protection**:
   - In `src/execution/preparation.ts:confirmConsent`, `askConsent` is raced against caller abort signals and monotonic budget timers via `Promise.race([promptPromise, cancellationPromise])`.
   - If a prompt callback hangs indefinitely or ignores the abort signal, caller cancellation or deadline expiration settles immediately without hanging, cleaning up event listeners and timers in `finally`.
3. **Response identity binding & validation**:
   - `ConsentPrompt` request and response strictly bind to the target `backend` and `model`.
   - Any response mismatching the requested backend or model is rejected with `ToolError('POLICY_DENIED')`.
4. **Late response and cancelled form protection**:
   - Delayed responses arriving after budget deadline expiration or abort signal activation are rejected immediately with `ToolError('TIMEOUT')` or `ToolError('ABORTED')`.
   - Form cancellation (`unanswered: true`), user decline (`approved: false`), unchecked approval, or conflicting responses (`approved: true` with `unanswered: true`) strictly reject with `ToolError('POLICY_DENIED')` and never execute the turn or invoke `rememberApprovedModel`.
5. **Varargs signal combination and backward compatibility**:
   - `combineSignals` in `src/storage/lock.ts` enhanced to accept arbitrary numbers of signals (`...signals`), safely merging caller signals, read context signals, and monotonic budget signals.
   - Full backward compatibility preserved for legacy invocations without budgets or read contexts.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 534 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 11 tests (11 pass, 0 fail, exit code 0): `node tests/run.cjs tests/execution/controller-consent.test.js`.
- PASS: Full test suite: 581 tests (578 pass, 0 fail, 3 skipped, duration 146.2 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audits conducted via MCP `coagent8` `review` (backend `codex`, model `gpt-6.1-sol`, session `syn_sess_145162966167c55e46993eeb`, Turn 3: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T10b: revalidate just before acquisition

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: re-verify identity, governance policy, and price evidence directly before session acquisition (`revalidateConsent` in `src/execution/consent.ts` and `src/execution/preparation.ts`), fail closed with retry guidance upon condition shift, protect `neverAsk` from invalid approvals, and preserve Primary Task Supremacy.

### Implemented mechanisms:
1. **Pre-acquisition revalidation gate (`revalidateConsent`)**:
   - Executes immediately before transitioning to session acquisition after user consent confirmation in `src/execution/preparation.ts:confirmConsent`.
   - Inspects disk configuration modification (`isConfigModified`) to avoid redundant reloads while detecting file modifications via `mtimeMs` and `size`.
   - Re-reads prices with `current: true` when consent was asked or when `output_price_below` is constrained, guaranteeing fresh pricing evidence.
2. **Condition shift detection and fail-closed retry guidance**:
   - `describeGovernanceChange` in `src/models/governance.ts` tracks whether the target model was added to `alwaysAsk`, removed from `neverAsk`, or if thresholds (`askAbovePrice`, `priceMultiplier`) were lowered/strictened, skipping threshold checks for models whose policy is already governed by explicit lists.
   - Price increases during consent wait reject with `ToolError('POLICY_DENIED')` and format user-facing retry guidance (`consentInvalidatedMessage`) without substituting the model (`NO_SUBSTITUTE`).
   - Price limit exceedance rejects with typed `ToolError('PRICE_LIMIT')`, distinguishing continuing sessions (`or start a new session`) from fresh turns (`or omit model`) via `Boolean(previousSession)`.
3. **Never-ask protection**:
   - `rememberApprovedModel` is guarded behind successful revalidation, guaranteeing that invalidated approvals never update `governance.neverAsk`.
4. **Pre-acquisition model identifier validation**:
   - `isValidModelIdentifier` asserts model safety in `src/execution/controller.ts` before session acquisition.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 536 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 37 tests (37 pass, 0 fail, exit code 0): `node tests/run.cjs tests/execution/controller-consent.test.js tests/execution/preparation.test.js tests/config-snapshot.test.js`.
- PASS: Full test suite: 594 tests (591 pass, 0 fail, 3 skipped, duration 142.5 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audits conducted via MCP `coagent8` `review` (backend `claude`, model `claude-opus-5-5`, session `syn_sess_9b5c70ab23c88d4e93805bf0`, Rounds 3 & 4: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T10c: preserve remembered-approval outcomes

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: preserve valid user approvals across configuration storage failures (Secondary Task Fault Isolation & Primary Task Supremacy), ensure Next-call policy consistency without false in-memory caching, redact credentials and user home paths from persistence warnings, and protect `governance.neverAsk` from cancellation before or during storage.

### Implemented mechanisms:
1. **Secondary Task Fault Isolation & Primary Task Supremacy**:
   - `rememberApprovedModel` failures (disk unwritable, permissions `EACCES`, disk full `ENOSPC`, file lock timeouts) in `src/execution/preparation.ts:confirmConsent` are caught and recorded as non-fatal warnings in `consentWarnings`.
   - The primary turn completes successfully with valid approved status, returning the redacted failure warning in `TaskExecutionResult.warnings`.
2. **Next-call policy consistency**:
   - When persistence fails, `governance.neverAsk` remains untouched on disk.
   - Subsequent calls reload fresh disk configuration via `loadConfigSnapshot()`, correctly requiring user consent again without being masked by any in-memory state.
3. **Diagnostic redaction & bounding**:
   - Storage failure warnings use `redactDiagnostic(..., 256)`, ensuring no tokens, keys, bearer credentials, or local user home directories leak into client-visible warnings.
   - Input model identifiers in `rememberApprovedModel` are validated against `isValidModelIdentifier` and bounded with `redactDiagnostic(model, 64)`.
4. **Cancellation before storage protection**:
   - Caller abort signals and monotonic budget timeouts are checked before and during `rememberApprovedModel` (supporting `options?: FileLockOptions | BackendReadContext | AbortSignal`).
   - Abort signal or budget expiry halts execution with typed `ToolError('ABORTED')` or `ToolError('TIMEOUT')`, rethrowing immediately and never writing to `neverAsk`.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (105 source files analyzed, 538 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 46 tests (46 pass, 0 fail, exit code 0): `node tests/run.cjs tests/execution/controller-consent.test.js tests/execution/preparation.test.js tests/config.test.js`.
- PASS: Full test suite: 602 tests (599 pass, 0 fail, 3 skipped, duration 144.4 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audits conducted via MCP `coagent8` `review` (backend `claude`, model `claude-opus-5-5`, session `syn_sess_5480c82e5d511346ce503eef`, Turns 2, 3 & 4: `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T11a: activate the budget for consult/review

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: activate monotonic complete-call budget for `consult` and `review` from tool call start, pass remaining monotonic execution time to adapters, ensure early phase expiry halts before model turn with `ToolError('TIMEOUT')`, prevent idle activity from resetting deadline, support teardown allowance during post-turn verification, and update `timeout_ms` documentation and source contracts.

### Implemented mechanisms:
1. **One Root Context Before Early Phases**:
   - Monotonic `ExecutionBudget` and `BackendReadContext` initialized at the entry of `consult` and `review` handlers (and in `server.ts` `callTool`) before Git collection (`collectReviewInput`), task preparation (`prepareTask`), pricing, and consent.
   - Disposed deterministically in `finally` blocks when owned.
2. **Passing Remaining Time to CLI Adapters**:
   - Early phases (Git diff, untracked scans, probe, model selection, catalog reads, price limit checks, consent) consume from the monotonic deadline.
   - CLI adapters (`codex`, `claude`, `agy`) receive `timeoutMs: budget.remainingExecutionMs()`, not the static caller `timeout_ms`.
3. **Monotonic Expiry & Idle Immunity**:
   - Deadline is strictly monotonic; progress events, streaming output, and I/O heartbeats never reset or extend the deadline.
   - Expiry during Git work, preparation, probe, or consent halts execution immediately with typed `ToolError('TIMEOUT')` before starting any model turn.
   - Aborted signals during backend probes/catalogs/prices resulting from budget expiration are accurately reclassified as `ToolError('TIMEOUT')`.
4. **Teardown Allowance & Teardown Read Context**:
   - `budget.ts` scales default teardown allowance down for small budgets (`min(DEFAULT_TEARDOWN_GRACE_MS, max(1, floor(totalBudgetMs * 0.2)))`) so small caller budgets never expire prematurely.
   - Post-turn review snapshot verification (`verifyReviewSnapshot`) uses a dedicated `teardownReadContext` (`phase: 'teardown'`) with `budget.teardownSignal` and `remainingTeardownMs()`, ensuring turns ending near the execution deadline can verify snapshots without false BLOCKED verdicts.
   - Untracked file collection and git failure reporting in `src/workspace/git.ts` observe phase-aware budget deadlines.
5. **Contract & Schema Documentation**:
   - Updated `timeout_ms` documentation in MCP tools/schema and `ExecutionOptions.timeoutMs` in `src/contracts/execution.ts` clarifying total monotonic budget semantics while preserving model-visible tool definitions budget (under 5,500 bytes).

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (106 source files analyzed, 561 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 68 tests (68 pass, 0 fail, exit code 0): `node tests/run.cjs tests/mcp/tools/consult.test.js tests/mcp/tools/review.test.js tests/execution/controller-timeout.test.js tests/mcp/surface.test.js tests/execution/preparation.test.js tests/execution/budget.test.js`.
- PASS: Full test suite: 621 tests (618 pass, 0 fail, 3 skipped, duration 161.4 s, exit code 0): `node tests/run.cjs`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).
- Independent review audits conducted via MCP `coagent8` `review` (backend `claude`, model `claude-opus-5-5`, session `syn_sess_2d0a5a0c5aa2b4338b63f2b9`, Rounds 1-6; Round 6 State Envelope evaluated to `COVERAGE: COMPLETE`, `VERDICT: READY`, 0 P1/P2 issues).

## EXEC-001-T11b: apply bounds to diagnostics

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: apply bounds and caller cancellation to diagnostics (`runDoctor`, `runModelReport`, `handleDoctor`, and server dispatch), define diagnostic execution budget, preserve doctor's input schema and MCP error message surface, ensure health reads are bounded, model view remains cheap, startup waits for no probes, and doctor creates no session.

### Changed files:
- `src/contracts/execution.ts`: Added `DEFAULT_DIAGNOSTIC_TIMEOUT_MS = 60_000` (bounds one doctor call, 3 s reserved for teardown). The default diagnostic budget value originates explicitly from the task prompt.
- `src/diagnostics/doctor.ts`: Added `signal?: AbortSignal` and `budget?: ExecutionBudget` to `DoctorOptions`. `runDoctor` and `runModelReport` create an owned execution budget (`totalBudgetMs: DEFAULT_DIAGNOSTIC_TIMEOUT_MS`, `parentSignal: signal`, `clock: options.clock`) if omitted and dispose it in `finally`. Combined `options.signal` and `budget.executionSignal` into a unified `readContext` passed to `probeBackend`, `readModelCatalog`, `inspectQuotas`, `readPrices`, `inheritedTools`, and `selectModel`. Added pre-flight and post-read expiry/abort checks. Rethrew `ToolError('ABORTED')` and `ToolError('TIMEOUT')` in `selectModel` and `recordDefaultModel` catch blocks while preserving recommendations for other errors. Placed post-read deadline checks before the timing observer block to guarantee single observer invocation.
- `src/mcp/server.ts`: Dispatched `extra.signal` into `handleDoctor(args, extra.signal)`. Preserved the MCP message-only error surface (`{ isError: true, content: [{ type: 'text', text: ... }] }` without error code) on doctor errors.
- `src/mcp/tools/doctor.tool.ts`: Added optional `signal?: AbortSignal` parameter to `handleDoctor` and threaded it to `runDoctor({ backend, signal })` and `runModelReport({ backend, signal })`.
- `tests/diagnostics/doctor.test.js`: Added comprehensive unit tests for pre-aborted signal rejection, pending-read aborts (for probes, catalogs, and selection), expired budget timeout rejection, context propagation to all 6 read primitives, and cheap model view cache validation.
- `tests/mcp/server.test.js`: Added tests verifying `handleDoctor` signal forwarding across both scopes (`health` and `models`), MCP server `extra.signal` forwarding and timeout error rendering (`isError: true`), probe-free server startup, and zero session files created by doctor calls.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (106 source files analyzed, 563 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 82 tests (82 pass, 0 fail, exit code 0): `node tests/run.cjs tests/diagnostics/doctor.test.js tests/backends/probe-cache.test.js tests/models/prices.test.js tests/backends/availability.test.js tests/mcp/server.test.js tests/mcp/result.test.js tests/mcp/surface.test.js tests/e2e/mcp.test.js tests/e2e/stdio.test.js`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).

### Independent review rounds:
Conducted via MCP `coagent8` `review` (backend `claude`, model `claude-opus-5-5`, session `syn_sess_b289c9f8cb63a6211a9fe578`):
- Round 1: `SNAPSHOT: ca11674+uncommitted#5e13e4043b6ebda759a7f193db5c1cc1d9652cad11b9ed91ee810c9981a78238`, `COVERAGE: COMPLETE`, `VERDICT: BLOCKED`. Findings: [P2] `doctor.ts:350` timing observer run twice on late timeout/abort; [P3] abort error message wording.
  - Remediation: Moved post-read budget and abort deadline checks before the `options.onTiming` observer block in both `runDoctor` and `runModelReport`. Updated abort error message to "Request cancelled during diagnostic execution."
- Round 2: `SNAPSHOT: ca11674+uncommitted#fafd19697ca17ddd8b197666305cb9bbf21fa8bea040a24072c0ee009cd2b75b`, `COVERAGE: COMPLETE`, `VERDICT: READY`. 0 P1/P2 issues. Server gate reported: `Verdict: BLOCKED (Required checks were not run (typecheck=NOT_RUN, tests=NOT_RUN); the reviewer answered READY)`. Independent approval not established (read-only audit gate).

Next card: EXEC-001-T11c (expose accurate timing).

## EXEC-001-T11c: expose accurate timing

Implemented 2026-10-10 on branch `perf/exec-001`.
Scope: Expose honest wall-clock duration from root call entry (including preparation, Git collection, consent, execution, and teardown/cleanup overruns) in `ExecutionMeta` (`durationMs` and `totalMs`). In `src/mcp/server.ts`, calculate elapsed monotonic duration for error results using `budget` instead of hardcoded `durationMs: 0`. Ensure footer remains clean, single-line per field, bounded, and emoji-free. Update contracts, tests, and documentation.

### Changed files:
- `src/contracts/execution.ts`: Added optional `totalMs?: number` to `ExecutionMeta` representing total elapsed wall-clock duration from root call entry through completion, while preserving existing callers relying on `durationMs`. Added `elapsedMs?(): number` method to `ExecutionBudget`.
- `src/execution/runtime/budget.ts`: Implemented `elapsedMs(): number` method on `ExecutionBudget` instance computing `Math.max(0, Math.round(clock() - startedAtMs))`.
- `src/execution/controller.ts`: Populated `meta.durationMs` and `meta.totalMs` with `trace.totalDurationMs` upon completion of `finalization` and trace emission, ensuring teardown and snapshot verification overruns are included in total call duration.
- `src/mcp/result.ts`: Updated `formatExecutionResult` to determine `durationMs` using `executionMeta.totalMs ?? executionMeta.durationMs`, safely clamped to non-negative numbers, preserving the exact single-line framed footer structure and bounds.
- `src/mcp/server.ts`: Supported optional `clock` option in `createServer`, initialized `budget` before workspace resolution, and passed `clock` into `execOptions`. In tool `catch (err)`, replaced hardcoded `durationMs: 0` with monotonic elapsed time calculated via `budget.elapsedMs()` or elapsed budget time, ensuring preparation failures, Git diff errors, and cancelled consent prompts report actual elapsed duration honestly.
- `src/mcp/tools/consult.tool.ts`: Initialized phase tracker at tool entry and passed to `executeTask`; ensured early exit before `executeTask` closes tracker and emits trace.
- `docs/ARCHITECTURE.md`: Documented complete call wall-clock duration in `ExecutionMeta` (`durationMs` / `totalMs`) and honest error footers; updated CUR-007 resolution.
- `docs/ROADMAP.md`: Marked T11c complete with evidence link.
- `docs/HANDOFF.md`: Recorded T11c implementation and verification details.
- `tests/execution/controller-timing.test.js`: Added unit tests verifying teardown and verification time are included in reported total duration.
- `tests/mcp/result.test.js`: Added tests verifying `formatExecutionResult` retains framed footer format, bounds, and handles zero/negative/large metadata durations.
- `tests/mcp/server.test.js`: Added tests verifying early preparation errors and cancelled consent waits format non-zero elapsed monotonic duration in error footers.

### Verification evidence:
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (106 source files analyzed, 563 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped test suite: 68 tests (68 pass, 0 fail, exit code 0): `node tests/run.cjs tests/mcp/result.test.js tests/mcp/server.test.js tests/execution/controller-timing.test.js tests/execution/outer-timing.test.js tests/execution/timing.test.js tests/mcp/surface.test.js tests/e2e/mcp.test.js tests/e2e/stdio.test.js`.
- PASS: `npm run lint:docs` (0 warnings, 0 errors, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).

### Independent review rounds:
- Codex (`gpt-6.1-sol`, session `syn_sess_535321a9bac60cb25b4ff5f2`):
  - Round 1: `SNAPSHOT: 6d35ff0+uncommitted#26e66a78b94cfb5bd7466c50b84107348e449cc947491c563e0548bad19980a2`, `COVERAGE: PARTIAL`, `VERDICT: BLOCKED`. Findings: No file-reading tools in sandbox thread outside diff.
  - Round 2: `SNAPSHOT: 6d35ff0+uncommitted#26e66a78b94cfb5bd7466c50b84107348e449cc947491c563e0548bad19980a2`, `COVERAGE: PARTIAL`, `VERDICT: BLOCKED`. Findings: [P2] `controller.ts:578` durationMs and totalMs in successful consult calls derived from later-starting tracker instead of root execution budget, omitting workspace resolution time.
    - Remediation: In `src/execution/controller.ts:578`, derived `totalMs` and `durationMs` using `typeof budget.elapsedMs === 'function' ? Math.max(trace.totalDurationMs, budget.elapsedMs()) : trace.totalDurationMs`. Because `budget` is initialized at root call entry before `resolveWorkspace` in `server.ts`, root call duration and workspace resolution are included in returned metadata.
  - Round 3: `SNAPSHOT: 6d35ff0+uncommitted#eb9d02efbbf4461cebda6a92573d3804d8ef5e4793c1986f2c6980ec9a28a68a`, `COVERAGE: PARTIAL`, `VERDICT: READY`. 0 P1/P2 issues found.
- Claude (`claude-opus-5-5`, session `syn_sess_0c6914d75e79f56fb1e46ce6`, scope `6d35ff0..HEAD`):
  - Round 1: `SNAPSHOT: 6d35ff0..HEAD#5486a2ea0c251420fdfc3c0c65ced80c1887cfdda18a9135f157e6b840eb04fb`, `COVERAGE: COMPLETE`, `VERDICT: READY`. Full codebase inspection via Read/Glob tools. 0 P1/P2 issues ([P3] advisory on constant clock in one test). Server gate reported: `Verdict: BLOCKED (Required checks were not run (typecheck=NOT_RUN, tests=NOT_RUN); the reviewer answered READY)`. Independent approval not established (read-only audit gate).

Next card: EXEC-001-T12a (repeat the baseline).

## EXEC-001-T12a: repeat the baseline

Captured 2026-10-10 on branch `perf/exec-001`.
Scope: Repeat baseline measurement execution across 5 repetitions of the T01b baseline
test suite (`node tests/run.cjs tests/execution/baseline.test.js tests/environment.test.js`)
under identical environment and parameters as T01c, comparing scenario observations,
phase accounting, and total execution timings against the T01c baseline.

### Source & Environment Identity:
- Platform: Windows 11 (`win32 x64`, OS release 10.0.26200)
- Node: `v26.10.0`
- Base Commit: `058677ca852881a7aa644ca153c5e0c54284d710` (058677c)
- Tree SHA: `a6abd78d6ec9f19f09454907a40f4bb0ede6c28e`
- Dirty Diff: None (clean working tree prior to documentation updates)

### Execution Measurements (5 consecutive runs, 9/9 tests passed on each run):
- Sample 1: Wall: 5090.1 ms | Test Runner: 4619.9 ms
- Sample 2: Wall: 5169.1 ms | Test Runner: 4847.3 ms
- Sample 3: Wall: 5473.7 ms | Test Runner: 4968.8 ms
- Sample 4: Wall: 6770.7 ms | Test Runner: 6146.8 ms
- Sample 5: Wall: 8317.5 ms | Test Runner: 7824.0 ms

### Summary Statistics:
- Test Runner Duration: Median 4968.8 ms | Range [4619.9 ms .. 7824.0 ms] (T01c baseline: Median 4516.4 ms | Range [3957.5 ms .. 6061.2 ms])
- Wall Clock Duration: Median 5473.7 ms | Range [5090.1 ms .. 8317.5 ms] (T01c baseline: Median 4926.0 ms | Range [4301.0 ms .. 6401.0 ms])
- Overhead comparison: +10.0% runner median (+11.1% wall median), reflecting honest monotonic timing, phase accounting, trace accumulation, and capacity checks wired across T02-T11.

### Comparison of Scenario Observations (T01c vs T12a):
| Scenario | T01c Probes | T12a Probes | T01c Catalog | T12a Catalog | T01c Launches | T12a Launches | T01c Duration | T12a Duration (Median / Range) | Assessment |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plain Cold | 1 | 1 | 1 | 1 | 1 | 1 | NOT_MEASURED | Median: 261 ms [219 .. 392 ms] | Identical counters; initial probe and catalog hit |
| Plain Warm | 0 | 0 | 0 | 0 | 1 | 1 | NOT_MEASURED | Median: 179 ms [163 .. 814 ms] | Identical counters; cached probe reused without reprobing |
| Explicit Model/Effort | 1 | 1 | 0 | 0 | 1 | 1 | NOT_MEASURED | Median: 210 ms [152 .. 315 ms] | Identical counters; model and effort passed cleanly |
| Priced Auto | 1 | 1 | 0 | 0 | 1 | 1 | NOT_MEASURED | Median: 205 ms [192 .. 360 ms] | Identical counters; selected `gpt-5.6-luna` under 5 USD ceiling |
| Continuation | 0 | 0 | 0 | 0 | 1 | 1 | NOT_MEASURED | Median: 201 ms [177 .. 233 ms] | Identical counters; turn advanced, native session ID propagated |
| Review | 1 | 1 | 0 | 0 | 1 | 1 | NOT_MEASURED | Median: 1810 ms [1525 .. 2864 ms] | Identical counters; diff inspected, envelope verdict `READY` |
| Concurrent (4 tasks) | 1 | 1 | 1 | 1 | 4 | 4 | NOT_MEASURED | Median: 792 ms [423 .. 1001 ms] | Identical counters; probe coalesced, 4 tasks run behind barrier |

### Phase Accounting Breakdown (T12a vs T01c):
In T01c, all phase duration counters were `NOT_MEASURED`. With T02-T11 instrumentation in place, phases are observed and verified:
| Phase | Plain Cold | Plain Warm | Priced Auto | Continuation | Review |
| --- | --- | --- | --- | --- | --- |
| `preparationDurationMs` | Median: 50 ms [21 .. 57 ms] | Median: 1 ms [1 .. 2 ms] | Median: 4 ms [4 .. 10 ms] | Median: 3 ms [2 .. 5 ms] | Median: 2 ms [2 .. 2 ms] |
| `consentDurationMs` | Median: 32 ms [22 .. 39 ms] | Median: 1 ms [1 .. 2 ms] | Median: 2 ms [1 .. 2 ms] | Median: 2 ms [1 .. 2 ms] | Median: 1 ms [1 .. 2 ms] |
| `acquisitionDurationMs` | Median: 23 ms [22 .. 59 ms] | Median: 26 ms [20 .. 33 ms] | Median: 22 ms [19 .. 52 ms] | Median: 23 ms [19 .. 33 ms] | Median: 21 ms [18 .. 32 ms] |
| `finalizationDurationMs` | Median: 80 ms [69 .. 129 ms] | Median: 76 ms [73 .. 273 ms] | Median: 100 ms [84 .. 136 ms] | Median: 90 ms [68 .. 101 ms] | Median: 929 ms [789 .. 1515 ms] |
| `gitCollectionDurationMs` | NOT_MEASURED (N/A) | NOT_MEASURED (N/A) | NOT_MEASURED (N/A) | NOT_MEASURED (N/A) | Median: 1644 ms [1362 .. 2537 ms] |

### Inconclusive / Unmeasured Scope Disclosures:
- **Concurrent per-task phase breakdown**: Individual tasks in the concurrent barrier scenario run concurrently; total barrier duration is measured (Median: 792 ms), but per-task phase breakdown is not emitted at top-level observation in `baseline.test.js`.
- **Error paths**: In the baseline suite (`tests/execution/baseline.test.js`), all 7 test cases exercise successful paths. Error path phases and early-exit timings (e.g., cancelled consent prompts, preparation errors, budget aborts) are tested in dedicated suites (`tests/execution/controller-timing.test.js`, `tests/mcp/server.test.js`, `tests/execution/outer-timing.test.js`), but are not part of `baseline.test.js`. Therefore, error path timings in the baseline suite itself are labelled `INCONCLUSIVE / NOT_IN_BASELINE_SUITE`.
- **`nativeProcessLaunchOverhead`**: `NOT_MEASURED` (synthetic fixture execution does not spawn native OS CLI processes).
- **`clientTransportLatency`**: `NOT_MEASURED` (synthetic test harness executes in-process controller calls directly rather than traversing JSON-RPC over stdio pipes).

### Verification & Artifacts:
- Raw benchmark execution outputs and observations preserved in scratch artifact: `scratch/baseline-results.json`.
- PASS: 5/5 repetitions exit code 0, 9/9 tests pass per run.
- PASS: `npm run typecheck` (0 errors across root and extensions/vscode, exit code 0).
- PASS: `npm run check:dependencies` (106 source files analyzed, 563 dependency edges, 0 violations, 0 cycles, exit code 0).
- PASS: Scoped baseline test suite: `node tests/run.cjs tests/execution/baseline.test.js tests/environment.test.js` (9/9 pass, exit code 0).
- PASS: `npm run lint:docs` (0 errors, 0 warnings, exit code 0).
- PASS: `npm run docs` (TypeDoc build clean, 0 warnings, exit code 0).
- PASS: `git diff --check` (clean whitespace and diff markers, exit code 0).

Next card: EXEC-001-T12b (validate the local candidate package).

T12a ran before AUDIT-001-A01-A07, AX-007a-c and WINDOWS-001a landed. Those
cards change quota/config storage and the review path, so T12b compares against
T12a only after repeating the baseline on the final source.

## AUDIT-001-A01-A03: quota cache read failure

Started 2026-10-10 on `perf/exec-001` at `07582ad`.

### A01 reproduction (unchanged source):
- Fixture: two active provider cooldowns (`codex`, `claude`) seeded in an owned
  temporary cache; `fs.openSync` mocked to fail only for that fixture path.
- REPRODUCED. `inspectQuotas(true, probes, { only: ['agy'], onCacheError })`
  replaced the file with an `agy`-only report; `recordQuotaCooldown('agy')` left
  `[ 'agy' ]` as the only provider. The locked writers treated the failed read
  as an empty cache. The missing-file case is separate and still creates a file.
- Limit: the I/O failure is simulated through the module's own `fs` binding;
  no native Windows sharing violation was produced.

### A02/A03 implementation:
- `src/backends/availability.ts`: an internal classified read distinguishes
  missing, valid, invalid (malformed JSON, no timestamp, over 64 KiB) and
  unreadable (any other I/O error). `readQuotaCache()` keeps its best-effort
  `null` contract.
- `inspectQuotas`, `recordQuotaCooldown` and `resetQuotaCooldown` merge into
  the classified read inside the lease. Missing or invalid content starts
  empty (invalid content holds no recoverable state, so the cache heals);
  an unreadable existing file throws before any write. `inspectQuotas` with
  `onCacheError` reports the failure and still answers from an unlocked read
  without writing; controller and doctor keep their existing warnings.

### Verification evidence:
- Regression `tests/backends/quota-read-failure.test.js` (7 tests): EBUSY/EPERM/
  EACCES keep the seeded bytes; doctor-style partial inspection warns and keeps
  bytes; propagation without `onCacheError`; invalid content replaced; missing
  file created. The five read-failure cases failed on the unchanged source.
- PASS: `node tests/run.cjs` with the regression, `backends/availability`,
  `execution/controller-cooldown` and `config` (18/18); DOCTOR and CACHE
  (46/46); `npm run typecheck`; `npm run check:dependencies`;
  `npm run lint:docs`; `git diff --check`.

Next card: AUDIT-001-A04.

## AUDIT-001-A04-A05: serialize configuration writers

### A04 reproduction (unchanged source):
- Caller search: `saveConfig`/`setDefaultBackend` have no source or extension
  caller; the bundle omits them. Only tests (27 files) call them. The defect was
  therefore not reachable from the shipped runtime, but the exported writer
  bypassed the lease every other configuration writer uses.
- Fixture `tests/config-writer-lease.test.js`: an owned helper process holds the
  configuration lease, reports `read`, waits for an explicit `write` message,
  then writes its read state plus `neverAsk: ['helper-model']`. The parent starts
  `saveConfig({ defaultBackend: 'claude' })` synchronously before sending `write`.
- REPRODUCED 5/5: the final parsed configuration lost `defaultBackend`; the
  control (`setBackendExecutable`, lease-respecting) kept both fields 5/5.
  A first draft that deferred the call to a microtask raced in both directions
  and was replaced by the message-ordered version.

### A05 implementation:
- `saveConfig` and `setDefaultBackend` are asynchronous; the whole
  read-modify-write runs under the configuration file lease and writes the same
  file it read. `writeConfig` is unchanged until A07; editor settings are not
  written, so file/editor precedence is unchanged.
- All 27 caller test files await the calls. Two synchronous `assert.throws`
  became `assert.rejects` with the same error predicates (invalid backend,
  uncreatable directory); no matcher changed.

### Verification evidence:
- PASS: `tests/config-writer-lease.test.js` (3 tests: lease wait, control,
  malformed config fails closed with bytes and no lease left) 5/5 runs; CONFIG
  group with the regression (17/17).
- PASS: full suite `node tests/run.cjs` (643 tests: 640 pass, 0 fail, 3 POSIX-only
  skips; 2 min 25 s, Windows, Node v26.10.0) before the fail-closed case was
  added; `npm run typecheck`; `npm run check:dependencies`; `npm run lint:docs`;
  `git diff --check`.

Next card: AUDIT-001-A06.

## AUDIT-001-A06-A07: atomic configuration writes

### A06 reproduction (after A05, unchanged writer):
- Fixture `tests/config-write-failure.test.js` fails renames onto the fixture
  configuration only, through both `fs.renameSync` and `fs.promises.rename`.
- REPRODUCED: three transient `EPERM` failures made `saveConfig` reject on the
  first attempt; `writeConfig` had no retry. A permanent `EBUSY` and a
  non-transient `EXDEV` were surfaced with the previous bytes intact and no
  temporary or lease file left.
- Limit: simulated error handling only. A native Windows sharing fixture needs
  a process that opens the file without delete sharing (Node always grants it);
  starting PowerShell for that risks a visible console, so native sharing is
  NOT_RUN. No claim is made that every open handle blocks rename.

### A07 implementation:
- `writeConfig` awaits the shared `atomicWrite` (temporary file, rename with
  the existing bounded EPERM/EBUSY/EACCES retry, temporary-file cleanup). All
  five writers await it inside the configuration lease; validation and
  file/editor precedence are unchanged. No second retry loop was added; the
  existing retry has no execution deadline, which stays with EXEC-001-T09.
- Two T10c consent tests injected storage failure through `fs.renameSync`;
  the injection moved to `fs.promises.rename` with unchanged assertions.

### Verification evidence:
- PASS: regression (3 tests: transient retried after 3 failures with new bytes;
  permanent and non-transient surfaced with old bytes, 1 attempt for EXDEV).
- PASS: full suite `node tests/run.cjs` (647 tests: 644 pass, 0 fail, 3 POSIX-only
  skips); `npm run typecheck`; `npm run check:dependencies`;
  `npm run lint:docs`; `git diff --check`.

Next card: AX-007a.

## AX-007a: state when another review cannot help

- `src/review/gate.ts`: when the reviewer answered READY, reported no P1/P2 and
  the only cause is required checks reported NOT_RUN, the reason reads: "The
  reviewer answered READY with no [P1/P2] finding, but the server did not observe
  the required checks (...); a read-only review cannot run them, so repeating the
  review will not change this verdict". The verdict stays BLOCKED; every other
  combination keeps its existing wording and lists every cause.
- `review` description adds once: "Read-only: checks are not run; an unchanged
  repeat cannot help." To stay within the owner's 5,800-byte definition budget,
  the shared `timeout_ms` description was shortened without losing a term
  ("Total monotonic call budget, ms: Git, prep, consent, CLI turn, teardown.").
  Measured model-visible definitions: 5,746 B before, 5,766 B after.
- ARCHITECTURE review gate contract and the gate TSDoc describe the reason.
  The `coagent8-review` skill already said the same; it is unchanged.

### Verification evidence:
- Fixtures in `tests/review/gate.test.js`: READY with only NOT_RUN (new reason),
  READY with a [P2] finding, reviewer BLOCKED with NOT_RUN, READY with NOT_RUN
  plus incomplete input (existing wording). The existing footer test expecting
  the old READY+NOT_RUN wording was updated to the new reason by design.
- PASS: REVIEW and MCP groups plus `simplify-s2` (73/73); `npm run typecheck`;
  `npm run check:dependencies`; `npm run lint:docs`; `git diff --check`.

Next card: AX-007b.

## AX-007b: label the continuation handle

- `src/mcp/result.ts`: the existing status line shows
  `session_handle=<handle> (<state>)` instead of the bare handle; no footer line
  was added.
- `session_handle` description (shared by consult and review): "Same-topic
  follow-up: footer handle; else a fresh agent rereads all." README states the
  same. `SERVER_INSTRUCTIONS` is unchanged: it is at 507 of the 512 characters
  every client reads, and the parameter description reaches the model at call time.
- Definition size: 5,766 B before, 5,798 B after (owner budget 5,800 B, unchanged).
- Legacy parsing: the documented result parser (`tests/helpers/result.cjs`)
  accepts the labelled and the bare handle; handle input is unchanged.

### Verification evidence:
- New `tests/mcp/result.test.js` case: labelled footer, one status line, handle
  appears once, labelled and legacy bare footers both parse. Four literal footer
  assertions were updated to the labelled form.
- PASS: MCP, E2E and `tests/mcp/tools` (61/61); `npm run typecheck`;
  `npm run check:dependencies`; `npm run lint:docs`; `git diff --check`.

Next card: AX-007c.

## AX-007c: refuse an unchanged repeat review

- Identity: collected snapshot (`identity#digest`), scope label, resolved backend
  and resolved model, in the same workspace. Instructions and effort are not part
  of it, as the card specifies.
- Storage decision: the outcome lives in the session record (`lastReview`), not
  in the history archive. Session records exist with `coagent8_HISTORY=off` and
  already define retention (2 h after last use; closed or invalidated sessions do
  not count). `sessions/` owns the record and `findCompletedReview`; the
  controller orchestrates, so `review/` and `sessions/` stay independent.
- Only a judged turn is recorded: the gate's new `judged` flag requires a
  complete, untruncated envelope with valid checks for the expected snapshot,
  and the workspace recheck must pass. A missing or malformed answer can be
  retried. Stored reasons are bounded to 600 characters; a malformed stored
  outcome is dropped without invalidating the session.
- The check runs after preparation resolves backend and model, before consent,
  session acquisition and the turn. A match returns "No model turn: ...", the
  earlier server verdict and reason, the earlier session handle in the body and
  no continuation handle in the footer. An unreadable sessions directory adds
  "Repeat-review check unavailable, so this review ran: ..." and the review runs;
  a failed record write adds a warning that a repeat will run again.
- README, ARCHITECTURE and the `coagent8-review` skill describe the behavior.
  The review tool description is unchanged (definition budget at 5,798 of 5,800 B).

### Verification evidence:
- Regression `tests/mcp/tools/review-repeat.test.js` (5 tests): identical repeat
  costs no turn and reports the earlier verdict; changed snapshot, scope, model
  and backend proceed; an unjudged answer may be repeated; unreadable sessions
  directory warns and runs; history off still refuses the repeat.
- PASS: full suite `node tests/run.cjs` (654 tests: 651 pass, 0 fail, 3 POSIX-only
  skips); `npm run typecheck`; `npm run check:dependencies`; `npm run lint:docs`;
  `npm run docs` (0 warnings); `git diff --check`.

Next card: WINDOWS-001a.

## WINDOWS-001a: per-call descendant survivors

Experiment `tests/execution/descendant-survivor.test.js` with the fixture agy mode
`native-descendant`: the server process stays alive, the fixture turn starts a
hidden Node descendant (`windowsHide`, ignored stdio) that increments a heartbeat
file, then hangs; the test cancels the turn and observes only that heartbeat for
500 ms. Nothing is selected or signalled by PID; the descendant exits on its own
on a stop flag or after 20 s.

| Descendant | Windows 11, Node v26.10.0 (3 runs) |
| --- | --- |
| In the root's libuv kill-on-close job (normal child of a Node root) | NOT_REPRODUCED 3/3: ended with the root |
| Outside any job (`detached`, no console): model of a native, non-libuv root's child | REPRODUCED 3/3: kept running after the cancelled turn returned |

Interpretation and limits:
- `terminateProcessTree` on Windows calls `proc.kill()` on the owned root only.
  A descendant dies with it only when some job closes with the root. A Node
  root has its own libuv job; native agy is not a Node process, so its children
  (user MCP servers started every turn, commands) are represented by the
  outside-job row. That row survives per-call cancellation while the server runs.
- The fixture does not prove native agy's actual job or child layout, whether
  agy ends its own children on stdin close, or survivors after server exit
  (c2eb228 observed none after a crash). No live desktop sweep was made.
- POSIX: the in-group scenario runs and is expected to pass through the process
  group signal; the outside-job scenario is Windows-only. POSIX was not run here.
- The outside-job scenario is a `todo` on Windows that records the expected
  contract (no survivor) until WINDOWS-001b-e implements per-call containment.

Owner decision 2026-10-10: a known limit of beta.2, not a blocker. Release notes
state it: in read-only profiles a cancelled or expired agy turn can leave its
native child processes, such as MCP servers, running until they exit or the
CoAgent8 server stops. WINDOWS-001b-e fix it before any write profile.

### Verification evidence:
- 3 consecutive runs, each: in-job scenario PASS, outside-job scenario TODO with
  `survivedCancel=true`; exit 0. Logs kept in the session scratchpad only.
- PASS: PROCESS and AGY groups; `npm run typecheck`; `npm run check:dependencies`;
  `git diff --check`.

Next card: EXEC-001-T12a repetition on the final source, then T12b.

## EXEC-001-T12a repetition on the final source

Captured 2026-10-10 at `240ac3c` (tree `eff2aed`), clean worktree, Windows 11
(10.0.26200), Node v26.10.0. Same command and 5 repetitions as T01c/T12a:
`node tests/run.cjs tests/execution/baseline.test.js tests/environment.test.js`.

- 5/5 runs exit 0 with 9/9 tests. Runner median 3,572 ms [3,504 .. 5,828];
  wall median 3,894 ms [3,851 .. 6,786]. Lower than T12a (4,969 ms runner
  median) on the same machine; the spread overlaps and no speedup is claimed.
- Counters identical to T12a for every scenario: plain cold 1/1/1
  (probes/catalog reads/launches), plain warm 0/0/1, explicit model/effort 1/0/1,
  priced auto 1/0/1, continuation 0/0/1, review 1/0/1, concurrent 1/1/4.
- Phase medians (ms): plain cold preparation 15, consent 23, acquisition 24,
  finalization 69; review preparation 2, acquisition 21, finalization 568,
  Git collection 1,025. The review scenario now includes the AX-007c session
  lookup before consent; its single review per run never matches a previous one.
- Limits unchanged from T12a: no native launches, no client transport, error
  paths outside the baseline suite. Raw aggregates were kept in the session
  scratchpad only.

Next card: EXEC-001-T12b.

## EXEC-001-T12b: local candidate package validation

Candidate `751d922` (tree `6e53be3`), branch `perf/exec-001`, 2026-10-10,
Windows 11 10.0.26200, Node v26.10.0, npm 11.19.1. Working tree clean except an
untracked `coverage/` left by a manual c8 rerun (removed after the identity
capture; not part of the package). Not a fresh clone. Nothing was published.

### First run (`82e28ba`): FAIL
Full coverage run: 650 pass, 2 fail, 3 skipped, 1 todo. Both failures were
wall-clock assumptions that held in isolation (3/3 plain and under c8):
`controller-cooldown` measured the 15 s tier from the start of the whole turn
(a 2.5 s turn under load gave 17.5 s), and `controller-consent` spent its
50 ms consent budget in preparation. `751d922` measures the cooldown from its
recorded start and starts the consent budget at the consent wait; tolerances
and assertions are unchanged. The whole gate was then repeated.

### Second run (`751d922`): PASS
| Step | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run check:dependencies` | PASS (0 violations, 0 cycles) |
| `npm run build` | PASS, before every bundle-dependent step |
| `npm run test:coverage` (full inventory) | PASS: 656 tests, 652 pass, 0 fail, 3 POSIX-only skips, 1 todo (WINDOWS-001a outside-job, REPRODUCED); statements/lines 93.23 %, branches 84.75 %, functions 95.44 % |
| `npm pack --dry-run --json` | PASS: `coagent8-1.0.0-beta.2.tgz`, 133 files |
| `npm run test:consumer` (new tarball) | PASS: install --omit=dev, bundled SDK, bin aliases, setup dispatch, MCP fixture turns; real CLIs NOT VERIFIED by design |
| `npm run lint:docs`, `npm run docs` | PASS, 0 warnings |
| `npm run package:vscode` | PASS: `coagent8-mcp-1.0.0-beta.2.vsix`, 21 files |

Artifacts (local, `.artifacts/`, not published):
- npm tarball SHA-256 `10896f67dacedf60d9a3544408e7ae1a764b1f36c8ccb3ca0dbd71d0ca3c55c3`
  (manifest beside it).
- VSIX SHA-256 `72798f469f6d19e363c2646a24fd0e7c681743377b1099f0389f12bab07384c5`.

Source, bundle and exact-package results are separate rows above: the coverage
run loads source, consumer smoke installs this exact tarball and compares its
bundle with a fresh build. The VSIX was packaged, not installed in VS Code.
Any later source change invalidates these artifacts.

Next: REPO-002c/d prepare the beta.2 PR branch (new SHAs, so T12b repeats on it);
then EXEC-001-T12c on that PR (CI matrix and native checks: agy issue-link click,
SKILLS-001e, VS Code acceptance) and T12d.


## REPO-002: branch model and release workflow (2026-10-10)

History reconstructed from the local session transcripts of 2026-10-06:
- The git-cliff session (morning) handed GitHub cleanup to another agent. That
  session backed up everything to `coagent8-backups/2026-10-06/`, removed the
  11 MIT-era commits and all rebrand commits (local history starts at tag
  `v1.0.0-beta.1`, the exact npm source), deleted and recreated the GitHub repo
  (`main` = GitHub's LICENSE commit `b962086`), added rulesets and opened
  PR #1, then stopped at the owner's request to keep work local.
- Not done since: npm placeholder/unpublish (the free 72-hour window ended
  2026-10-08 22:59 UTC), PR #1 (six failing checks), tags and releases.
- Found 2026-10-10: the branch ruleset requires checks for Node 20.x/22.x while
  `ci.yml` reports 24.x/26.x, so no PR can merge until the ruleset changes.

Owner decisions 2026-10-10 and the resulting plan are in
[REPO-002](ROADMAP.md#repo-002-branch-model-and-release-workflow): PrestaShop
model (`develop` + `X.Y.x`, no `main`), only Verified squash commits on
protected branches, the 293 local commits as one squash PR, beta.1 GitHub
Release, beta.2 preview on npm `next`, beta.1 deprecated, CI on Node 24/26.
The verified PrestaShop layout (default `develop`, lines `9.2.x`/`8.2.x`,
tags and releases per version, no `main`) was checked with the GitHub API.

Done locally (REPO-002a/b): rule 02 rewritten (who does what, branching,
backports, five release phases, npm channels, rulesets), rule 00 section 2,
AGENTS.md, the workflow skill, the ARCHITECTURE decision log, `ci.yml` triggers
for `develop` and `[0-9]+.[0-9]+.x`, and `.github/workflows/release.yml`
(draft release only, never publishes). Checks: both workflows parse as YAML;
`git-cliff --current --offline` renders the notes on `v1.0.0-beta.1`; the
online run needs the commits on GitHub; `git diff --check`. The workflow has
not run on GitHub yet.

Next: REPO-002c/d (agent, local), then the owner steps in REPO-002.

## REPO-002c/d/e: beta.2 pull request branch and API site

Owner approval 2026-10-10 to move the unpublished local tag. All local; nothing
was pushed.

- beta.1 commit X `9795432`: parent GitHub's `b962086`, tree of the former
  root `ae55f01` (equal tree verified), original message and dates. Local tag
  `v1.0.0-beta.1` moved to X (former tag object `1380681`, same message and
  date). `perf/exec-001` is unchanged as the pre-migration reference.
- `release/v1.0.0-beta.2`: `git rebase --onto X ae55f01` of all commits
  (linear, no merges); the final tree equals `perf/exec-001`'s tree; 295
  commits after X at that point, one author (the owner), no AI trailers.
  Ignored build outputs in `dist/` blocked the replay of the commit that
  stopped tracking `dist/`; they were moved aside and rebuilt.
- REPO-002d `9c72194`: README install from npm `next` and the GitHub
  release with `SHA256SUMS`; VS Code README and VSIX link base use `develop`.
- Release commit `944e030` `chore(release): v1.0.0-beta.2`: the detailed
  beta.2 section (150 entries from the branch commits) is frozen in the
  `cliff.toml` footer above beta.1; changelog scripts start at
  `v1.0.0-beta.2`; CHANGELOG.md equals the output for an empty range.
- Release notes drafts (ignored, English): `.local/release/v1.0.0-beta.2/release-notes.md`
  (status, known limits, upgrade note, generated notes) and
  `.local/release/v1.0.0-beta.1/release-notes.md`.
- Full gate on `944e030` (tree `5c7689c`, clean): typecheck, dependencies,
  build, coverage 656 tests (652 pass, 0 fail, 3 POSIX skips, 1 todo; 93.23 %
  statements), pack, consumer smoke, lint:docs, docs, VSIX all PASS. Tarball
  SHA-256 `b04f8d4d...11ab7e`, VSIX `afd585ee...6ffd6d06`. Superseded by the
  final gate below because README and docs changed afterwards.
- REPO-002e: `docs.yml` deploys the TypeDoc site to Pages on a published
  release; TypeDoc adds the project documents with front matter titles and
  renders mermaid through `tooling/documentation/mermaid.js`. ROADMAP headings
  changed from `ID - title` to `ID: title` (27) and every `---` anchor link
  was updated, because TypeDoc collapses repeated hyphens and GitHub does not.
  `npm run docs`: 0 warnings. Diagram rendering in a browser and the Pages
  deployment are NOT_RUN.
- Final gate on `7adccdc` (tree `d84f40d`, clean working tree, Windows 11,
  Node v26.10.0, npm 11.19.1): typecheck, dependencies, build, coverage 656
  tests (652 pass, 0 fail, 3 POSIX skips, 1 todo; statements 93.23 %, branches
  84.74 %), pack (133 files), consumer smoke of the new tarball, lint:docs,
  docs (0 warnings), VSIX: all PASS. Tarball SHA-256
  `56c8956e62c50839609925762465abd087b9c41b928236d9eeb5e92ea322d5d9`, VSIX
  `612ac5855b1898c73b1123b6bfbff826ac137be61c68eeed3592fbbf95873a87` (local
  `.artifacts/`, not published). The release workflow rebuilds them on GitHub
  from the tag; compare them with this record.

Next: the owner steps in REPO-002 on GitHub and npm.

## EXEC-001-T12c: native VS Code acceptance, first run (2026-10-10)

Owner run of VSIX `612ac585...873a87` on Windows 11, VS Code 1.141.0, default
profile; Codex CLI 0.160.0, Claude Code CLI 2.1.295, Antigravity CLI 1.3.3, all
standalone. Result: FAIL; the remaining cases were NOT_RUN.

- Uninstall, from the Extensions view and through **CoAgent8: Uninstall
  CoAgent8**: FAIL. The CoAgent8 entries in all three CLIs stayed. The
  `vscode:uninstall` hook ran four times (shared-process log, 20:29-20:39) and
  reported each entry as `preserved` ("no matching ownership"). Set Up Coding
  CLIs showed them as "manual entry, kept" from the first activation.
  - Cause: the entries were written by earlier VSIX builds (data directory in the
    extension's global storage), but `~/.coagent8/setup.json` with their
    fingerprints and the runtime copies they start were gone before this run.
    Ownership depended on that record alone, so CoAgent8 treated its own
    entries as manual: it never removed or updated them, they started a missing
    runtime (the CoAgent8 server in this repository's Claude Code session failed
    with "Connection closed"), and no client received skills.
  - Fix: `entryOwnership` (`src/integrations/setup-storage.ts`) also
    recognizes an entry by the shape only setup writes: it starts
    `~/.coagent8/runtime/<sha256>/index.cjs` and holds no other field or variable;
    a data directory `globalStorage/okidev.coagent8-mcp` marks the extension's.
    Status, setup and cleanup share it. Setup replaces an owned entry whose
    runtime copy is gone without probing the dead connection first.
- The uninstall command ended with **Quit VS Code**: rejected by the owner. It
  now offers **Restart Extensions** (`workbench.action.restartExtensionHost`),
  the step VS Code's Extensions view offers after an uninstall
  (`runtimeState.action`). A suggested `requiresReload` manifest field does not
  exist: VS Code 1.141.0 contains no such string.
- Switching between the standalone agy and the copy the Google Antigravity
  extension downloaded: PASS (owner).
- `~/.coagent8` holds `config.json`, written by that switch; it is the shared
  configuration and stays after an uninstall by design. A `~/.cagent` directory
  does not exist in this profile and is not CoAgent8's.
- Checks after the fix: `tests/integrations/{setup,cleanup,vscode-extension}.test.js`
  60/60 PASS; the two new tests fail on the previous source.
- Full gate on `a2306e1` (tree `1d11932`, clean, Windows 11, Node v26.10.0):
  typecheck, dependencies, build, coverage 658 tests (654 pass, 0 fail, 3 POSIX
  skips, 1 todo; statements 93.26 %, branches 84.83 %), pack, consumer smoke,
  lint:docs, docs, VSIX: all PASS. Tarball SHA-256
  `e702eb3cdd463edfd46eccf1cbc92a2c49fc0a26c0a8f56a352b5dc839e425ee`, VSIX
  `a56fc6d07466bd4ab55cd4cd168b91bd42c08c20f07d74d689330a4f87fa01fe`; they
  replace the final gate's artifacts above. The two fixes are added to the frozen
  beta.2 changelog section.

Next: a repeated owner run of every case with this VSIX.

### Second run with VSIX `a56fc6d0...fa01fe` (2026-10-10, 21:17-21:22)

- Registrations: PASS. The `vscode:uninstall` hook removed the three stale
  entries (`removed`), Set Up Coding CLIs registered all three with 6 skills each
  (Codex host-callable), and **Uninstall CoAgent8** removed the three entries and
  18 skills. A stale Claude entry reappeared 14 s after the hook removed it, most
  likely written back by a running Claude Code session; it was absent at the end.
- Standalone CLIs: FAIL. Standalone Claude Code, Codex and Antigravity CLI stayed,
  none was offered for removal. An earlier CoAgent8 build had installed them, but
  the record lived in the extension's global storage, which VS Code deletes on
  every uninstall. The official installers also leave more than the binary:
  `claude install` adds `~/.local/bin` to the user PATH; the agy installer makes
  `%LOCALAPPDATA%\agy\bin` a junction to `~/.gemini/bin` and adds both to PATH;
  the OpenAI Codex installer links `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` ->
  `~/.codex/bin` -> `~/.codex/packages/standalone/...`. Set Up Coding CLIs showed
  the agy behind that junction as a second installation, labelled as the Google
  extension's download although that extension was not installed, and never asked
  whether to use a vendor extension instead.
- On the owner's instruction the standalone CLIs were removed by hand: junctions
  first, then the files, the emptied folders and five user PATH entries (backup
  of the previous value kept in the session scratchpad); `backends.codex.executable`
  was dropped from `~/.coagent8/config.json`. That write left the user PATH as
  `REG_SZ` with expanded paths. The VS Code Claude Code extension, sign-ins,
  configurations and the running `~/.codex/packages/app-server-daemon` stayed.
- Fixes: the install record moves to `~/.coagent8/installs.json` (earlier lists
  migrate from the extension storage); a CLI found only as a standalone
  installation is offered the vendor extension once; **Install Standalone CLI**
  says the installer changes PATH; sources compare by real path, and agy in
  `~/.gemini/bin` without the Google extension is labelled standalone; the
  Windows removal command deletes the agy junction itself, the files, emptied
  installer folders and their user PATH entries through the registry, keeping
  the value's type and unexpanded variables. A Windows test runs that command
  against a junction fixture and a registry key of its own.
- Full gate on `3d23dc1` (tree `7f10b19`, clean, Windows 11, Node v26.10.0):
  typecheck, dependencies, build, coverage 663 tests (659 pass, 0 fail, 3 POSIX
  skips, 1 todo; statements 93.3 %, branches 84.78 %), pack, consumer smoke,
  lint:docs, docs, VSIX: all PASS. Tarball SHA-256
  `1bc485be6fe94d727deb1c902161b154a0062fb4daceb80fea75ab742c60d865`, VSIX
  `261c790ca88592ef426c03a7f2c6eba3cd38792e4fe58c42b8cd3e515eb65ed2`; they
  replace the previous artifacts.

The owner's next setup run exposed missing Claude and agy copies selected with
`backends.<id>.executable: "vscode-extension"`. Setup incorrectly classified
these as blocked configuration paths, suppressing the installation offer. The
local fix reports the missing selected copy as not installed without falling
back to another installation. Explicit paths and environment overrides still
fail closed. Choosing **Install Standalone CLI** replaces the unavailable
extension preference with automatic discovery; dismissing the offer or choosing
the vendor extension preserves it. `setup-state.json` stores onboarding state;
`~/.coagent8/installs.json` stores installed dependencies across uninstalls.

Fresh scoped evidence on Windows, Node v26.10.0: typecheck, build, 68 setup,
CLI-readiness, VS Code and package tests, consumer smoke, lint:docs, docs and
VSIX packaging PASS. New tarball SHA-256
`621f379adf2afb92dcbea42348e2fe46046df61522b2344fa58032bf4922b4cb`;
VSIX SHA-256
`18838a2b711fbad1b3e046cb3de49ee6c147871062d25f2a9e261c33d8674a56`.
These replace the artifacts above. CoAgent8 independent review returned
BLOCKED/PARTIAL because the reviewer lacked file-reading tools to inspect
surrounding code; reviewer checks were NOT_RUN. This is not release approval.
Native owner acceptance on 2026-10-10: the owner reports installing the
replacement VSIX and all three vendor-extension CLIs, all marked Ready, and
seeing all installed skills. The installed VSIX digest and resolved CLI paths
were not independently read from the host. This establishes owner-reported
recovery of the missing-extension installation case, not the full lifecycle.

Cross-client MCP smoke evidence:

| Caller | Backend/model | Observed result | Evidence boundary |
| --- | --- | --- | --- |
| This Codex chat | agy / gemini-3.8-flash-high | `17 * 23 = 391`, footer 10.1 s, ready | Actual `mcp__coagent8__consult` result; handle `syn_sess_d0e6e6c9d37c4d43aca54c4f`. |
| Claude chat, owner-provided account | codex / gpt-5.6-luna and agy / gpt-oss-120b-medium | Both returned `2 + 312 = 314`; reported 4.6 s / 7.5 s, output prices USD 1.2 / 0.17 per million | Caller reports parallel calls with `output_price_below: 3`, no explicit model or consent prompt, and price/source/date evidence in footers. Raw calls and full footers were not supplied. |
| agy chat, owner-provided account | codex / gpt-6-luna | `21 + 213 = 234`, footer 4.1 s; handle `syn_sess_c1af9afa70387c71bba99f50` | Caller reports loading the skill/tool descriptions and doctor before consult; quoted output price USD 0.50 per million. Raw doctor/call output was not supplied. |

These demonstrate successful MCP consultations across the three callers and
reported skill discovery. They do not establish actual billing, timing phase
boundaries, sandbox isolation, session continuation or review quality. In
particular, the agy caller's positive sandbox assessment is an opinion without
a capability test. Only consult skill use was described; explicit use of every
installed skill remains unverified.

Native uninstall selection/removal: owner-accepted PASS on 2026-10-10. The owner
reports that the CoAgent8 uninstall command presented the extensions available
for removal and successfully removed the selected example. The extension's
identity and post-uninstall filesystem/registration preservation checks were
not supplied. This accepts the reported selection/removal case; cancellation,
Extensions-view removal, full restart and reinstall remain separate cases.

Native post-uninstall restart: owner-reported FAIL on the previous VSIX. Claude
Code's chat and its pending Restart Extensions action remained after using
CoAgent8's restart button; the native Extensions-view action completed the
transition. Source inspection of upstream VS Code on 2026-10-10 explains the
difference: [RestartExtensionHostAction](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/extensions/electron-browser/nativeExtensionService.ts)
starts hosts without an extension delta, whereas
[updateRunningExtensions](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts)
computes and passes the pending additions/removals. The
[native runtime-state button](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/extensions/browser/extensionsActions.ts)
uses the latter internal service. CLI Ready only establishes executable
readiness and does not establish completed editor extension removal.

The local uninstall fix offers **Reload Window** and invokes
`workbench.action.reloadWindow` after all selected uninstall commands complete.
Registration-only setup continues to offer a host restart. Fresh typecheck,
36 VS Code integration tests and VSIX packaging PASS. The first test run had
one stale closing-message assertion; its wording was updated while retaining
the terminal-removal assertion, and the focused suite then passed. New VSIX
SHA-256 `0c276677efcb35c6a1c7c7a53f45ab6c41d66e95daa17f4e6cf86e758786662f`
replaces the VSIX above; npm runtime/tarball is unchanged. Native acceptance of
the replacement action and independent review of this added fix are NOT_RUN.

Next: repeat the post-uninstall action with the new VSIX, obtain independent
approval of both fixes and finish the remaining
native lifecycle/skill acceptance and release gates against the candidate.

## SKILLS-002: complete independent skill management

Owner authorization 2026-10-10: full implementation after EXEC, with high
reasoning effort. [Accepted plan](ROADMAP.md#skills-002-independent-skill-management)
extends the existing catalog, setup lease, ownership and config owners. Work
remains on the owner's existing local candidate stack, without Git integration.

Implemented one VS Code command, **CoAgent8: Manage Skills**, and the shared CLI
`coagent8 skills status|install|uninstall|enable|disable`. Choose a client and
one or all catalog packages; inspect actual state, updates and user-directory
scope. Management changes no MCP entries and starts no backend. Cancellation
and empty selections change nothing. CLI mutations preview first and require
the exact returned digest to apply one client at a time.

Desired installed/disabled lists live in `backends.<client>.skills` in shared
`config.json`; actual digests and per-package CLI/extension origin live in
`setup.json`. `setup-state.json` remains onboarding state. Setup/repair/update
honor explicit choices, including opt-out and disabled packages; new catalog
names are offered without silently joining explicit selections. Catalog
removal cleans up only unchanged owned copies. Legacy records remain accepted.

Portable disable retains packages in `~/.coagent8/disabled-skills/<client>/`,
outside client discovery; enable restores them. Native activation overrides,
other discovered copies and shared-directory effects remain distinct. Existing
conversation content is not erased. The existing agy root follows SKILLS-001's
native evidence; differing current documentation is not used to silently move
packages. No bundled script executes and no third-party skill is managed.

Apply binds config, ownership, selection, catalog and observed files. The setup
lease serializes changes; the config lease rechecks the previewed bytes. A
bounded journal records package snapshots before effects and ownership last.
Failed writes roll back; interrupted writes recover on the next mutating setup,
repair, cleanup or skill operation. Later user edits stop recovery and preserve
both files and journal. Desired intent is durable before file effects, so repair
can retry a failed apply. Linked ownership/skill ancestors are rejected before
lease writes. Mixed CLI/VSIX package ownership is retained across toggles and
filtered separately during extension uninstall.

Final local Windows/Node v26.10.0 verification:

- Typecheck, build and dependency boundaries PASS (109 files, 589 edges,
  zero cycles/boundary violations).
- Focused setup, skills, VS Code and package scope: 76 PASS, zero failures
  (`.artifacts/skills-focused-tests.log`).
- Final full suite: 678 tests, 674 PASS, zero failures, 3 platform skips,
  1 existing WINDOWS-001a TODO (`.artifacts/skills-final-full-tests.log`). The
  earlier full run was 675 tests before the last three regressions were added.
- Source documentation lint and generation PASS. One generation attempt
  rejected the old proposal anchor; correction passed. Local Markdown review
  checked 22 documents / 150 links with zero issues; git diff --check PASS.
- Pack inspection, VSIX packaging and exact-tarball consumer smoke PASS.
  The consumer's initial supplied-artifact attempt required a missing manifest;
  a sidecar was generated from the actual tar archive contents/digest, then the
  exact tarball passed installation, bundle/source comparison, both bin aliases,
  setup dispatch, fixture MCP turns/history and EOF. The earlier CLI regression
  caught generic diagnostic redaction removing a preview token; output now
  redacts paths/messages structurally and preserves that non-credential digest.

Replacement tarball: `.artifacts/package/coagent8-1.0.0-beta.2.tgz`, 136 files,
SHA-256 `8b23bbe6c9d0ddee7fc736a2aea7cbf940717765cbd0fe3fa209ab302ca06e82`.
Replacement VSIX: `.artifacts/coagent8-mcp-1.0.0-beta.2.vsix`, 21 files,
SHA-256 `7e4e63044a9aec22c66afaaeb56ad54d81302981bfb4f588c7dd0bec4cd7bc00`.
These supersede both artifacts above. Evidence: `.artifacts/skills-final-vsix.log`,
`.artifacts/package/artifacts.json`, tarball manifest sidecar and
`.artifacts/skills-final-consumer.log`. No installed-owner profile was modified
to run fixture checks; no commit, push, merge, tag or publication occurred.

Independent CoAgent8 `review`: agy / gemini-3.8-flash-high,
`session_handle=syn_sess_c1afaf19691f25173662cf48`. First turn exhausted its
120 s budget (ABORTED); same-topic continuation used 300 s and completed in
239.1 s / 19 operations. Reviewer reported COMPLETE, READY and no P1/P2 for
the source/integration scope, snapshot
`4437de4+uncommitted#70e9785679d26a4030e2632b00720c142b19d63082581e1a0a516b350285b121`.
Raw review: `.artifacts/skills-independent-review.txt`.
Reviewer checks were NOT_RUN. Server verdict is BLOCKED because it did not
observe required checks; an unchanged repeat cannot fix that gate. Local PASS
above is author-executed, not independent release approval. Base HEAD was
`4437de45784034d7ae7ec51f471da10797a3646e`; no committed candidate/tree binding
exists. Subsequent edits only record this evidence in documentation.

A later author review found that an emptied `~/.coagent8/disabled-skills/<client>/`
survived enable, uninstall and extension cleanup, so uninstall kept
`~/.coagent8`. Package removal and rollback now remove empty disabled storage
without following links; a regression covers two clients. Scoped evidence:
typecheck, lint:docs, dependency boundaries, git diff --check and 44 skills,
setup and cleanup tests PASS; the regression fails without the fix. The full
suite was not repeated. The tarball and VSIX above predate this change and are
superseded; no replacement artifact was built.

Native management discovery/refresh, repair persistence in each real client,
shared-directory behavior and the new post-uninstall Reload Window action
remain NOT_RUN on this replacement candidate. Fixture passes do not accept
those scenarios. The full release CI matrix and committed artifact-bound
independent approval remain pending; local implementation is not publication.

## Beta.2 candidate `861f350` (2026-10-10)

- Local branches: every `feat/*`, `fix/*`, `docs/*`, `build/*` and other local
  branch has its content in `release/v1.0.0-beta.2` by patch identity; the one
  commit each lacks is the former root `ae55f01`, whose tree equals `9795432`.
  The exception was `docs/readme` with `de47a4d` (README feature reference and
  badges, 2026-10-07). `861f350` brings its badges, contents, features,
  configuration and known limitations to the beta.2 README, checked against the
  current source and linking only existing documents.
- Full gate on `861f350` (tree `787720a`, clean, Windows 11, Node v26.10.0):
  typecheck, dependencies, build, coverage 679 tests (675 pass, 0 fail, 3 POSIX
  skips, 1 todo; statements 93.27 %, branches 84.85 %), pack, consumer smoke,
  lint:docs, docs (README on the API site, 0 warnings), VSIX: all PASS. Tarball
  SHA-256 `7e9b3b2b668b8cd347246570b303956e83fc948bf3c3214b53759ce0cc1e9b51`,
  VSIX `6f1cc358f9dcb965c6fab17664e5de02a82a096d1295c87e4d96293b449b95ff`; they
  supersede every artifact above and contain skill management, the emptied
  disabled-storage cleanup and Reload Window.
- The VSIX installed in the owner's profile at 22:16 predates skill management;
  native acceptance must use this VSIX.

REPO-002g (2026-10-11, owner decision): `release.yml` signs build provenance
and prints the verification commands in the notes; `npm-publish.yml` publishes
the verified release tarball with npm trusted publishing once the owner enables
it after beta.2. Rule 02 phases C-E and section 8, ROADMAP owner steps 7-9,
ARCHITECTURE decision log and the README tester guide follow. Checks: all four
workflows parse as YAML, `npm run docs` without warnings, `git diff --check`;
actionlint and the first GitHub runs are NOT_RUN. These commits change no file
of the VSIX (its README is the extension's), so the VSIX above stays the native
test candidate; the npm tarball differs only by the root README, and the release
workflow rebuilds both from the tag.

Next: owner native run of Manage Skills, the uninstall with Reload Window, an
Extensions-view uninstall followed by reinstall and Uninstall CoAgent8 offering
the recorded vendor extensions; then T12d independent review with observed
checks and the REPO-002 owner steps.

## Compact handoff contract

For subsequent tasks supply: objective/role/profile, allowed scope and acceptance;
workspace/branch/target plus base/candidate or dirty-diff identity; changes;
checks with commands, platform, PASS/FAIL/NOT_RUN and evidence; unresolved work and
next action. Link to rules instead of copying them. A reviewer needs original
requirements and the actual candidate, not just an implementation summary.

