---
title: Handoff
---

# CoAgent8 handoff

Updated 2026-11-03. Read this for current work, [ROADMAP.md](ROADMAP.md) for
priorities and acceptance, and [ARCHITECTURE.md](ARCHITECTURE.md) for contracts.
Evidence of finished work is in [docs/delivered](delivered/README.md); this file
links it instead of repeating it. Do not append session transcripts or treat old
test counts as fresh evidence.

## Current state

- **Versions:** `0.7.0` is released ([record](delivered/0.7.0/README.md)).
  `develop` at `3f7994c` (#146) is the `0.8.0` candidate, not tagged
  ([record](delivered/0.8.0/README.md), [plan](ROADMAP.md#080-plan)).
- **Working rules (owner 2026-11-02):** the backlog is in GitHub Issues
  ([`project.md`](../.agents/project.md#backlog)); an issue is closed by solving
  it. A clean PR is merged when its gate, CI and available reviews pass, and bugs
  another agent reports are fixed as they come. Tags, publication and repository
  settings need the owner.
- **Delivered for 0.8.0:** asynchronous `delegate` with task records, `wait`,
  Claude Code wake-up and the server-owned loop
  ([DELEGATE-001](delivered/0.8.0/DELEGATE-001.md)); Windows containment
  ([WINDOWS-001](delivered/0.8.0/WINDOWS-001.md)); reviews in parts and checks
  the server runs before a review ([REVIEW](delivered/0.8.0/REVIEW.md));
  [STANDARDS-001](delivered/0.8.0/STANDARDS-001.md) and
  [FORMAT-001](delivered/0.8.0/FORMAT-001.md).
- **Approval forms in real clients (#135, #140):** Claude Code 2.1.317 in
  VS Code answers `decline` and Codex 0.164 answers `cancel` without showing the
  form, for model and check approvals alike. CoAgent8 reports that as the
  client's answer. In these clients the loop and review checks run only when
  listed in `allowedChecks`, and an `ask` model only after the user allows it in
  the configuration.
- **Wake-up:** Claude Code is woken by the background `wait_argv` command
  (`wakeup: background_wait`); Codex and agy get `wakeup: none` and poll or read
  the task (owner's acceptance 2026-11-03,
  [record](delivered/0.8.0/DELEGATE-001.md#clients-as-callers-owners-acceptance-2026-11-03)).
- **Registered runtime:** every client (Codex, Claude Code, agy and the VS Code
  `mcp.json`) runs the CI-built VSIX of `a175892`. It predates #139-#146, so the
  newest CI VSIX is to be registered in all of them together after the next
  merge.

## Open issues

| Issue | State | Needs |
| --- | --- | --- |
| [#113](https://github.com/oktawianwybieralski/coagent8/issues/113), [#114](https://github.com/oktawianwybieralski/coagent8/issues/114) | Codex and agy wake-up | the owner in an open Codex window and the agy hub |
| [#137](https://github.com/oktawianwybieralski/coagent8/issues/137) | Codex extension freeze on a thread that quotes `wait_argv` in a table | a repro in a fresh Codex thread |
| [#138](https://github.com/oktawianwybieralski/coagent8/issues/138) | agy hub stops after reading the tool schemas; the agy CLI works headless | a repro in the hub |
| [#120](https://github.com/oktawianwybieralski/coagent8/issues/120) | Dependabot alerts in the documentation tooling | a TypeDoc release |
| [#111](https://github.com/oktawianwybieralski/coagent8/issues/111) | job helper on `arm64` and under SmartScreen | an `arm64` machine |
| [#112](https://github.com/oktawianwybieralski/coagent8/issues/112) | SignPath Foundation signing | the owner's application |

## Next

Group 1 of the [0.8.0 plan](ROADMAP.md#080-plan): parallel workers under one
root budget. Earlier evidence moved out of this file on 2026-11-03:
[0.8.0 notes](delivered/0.8.0/handoff-notes.md),
[0.7.0 notes](delivered/0.7.0/handoff-notes.md),
[up to 0.6.1](delivered/0.6.1/README.md).

## Compact handoff contract

For subsequent tasks supply: objective/role/profile, allowed scope and acceptance;
workspace/branch/target plus base/candidate or dirty-diff identity; changes;
checks with commands, platform, PASS/FAIL/NOT_RUN and evidence; unresolved work and
next action. Link to rules instead of copying them. A reviewer needs original
requirements and the actual candidate, not just an implementation summary
([review input](../.agents/rules/core/03-review.md#review-input)). Name pull
requests by number (`PR #51`), never "this PR": the text outlives the PR.
