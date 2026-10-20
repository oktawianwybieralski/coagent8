---
title: ACCEPT-001 in 0.7.0
---

# ACCEPT-001 in 0.7.0: automated native acceptance

Card at closure: [ROADMAP ACCEPT-001 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#accept-001-automated-native-acceptance); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#67](https://github.com/oktawianwybieralski/coagent8/pull/67) | `95ade80` | 2026-10-16 | feat(acceptance): isolate user home and add native runner skeleton |
| [#71](https://github.com/oktawianwybieralski/coagent8/pull/71) | `b067445` | 2026-10-18 | feat(acceptance): drive scenarios N2-N4 through the real CLIs |

## Scope at closure

Each item was met in the merges above.

- [x] 2.15 `ACCEPT-001b`: isolated instances and the runner set their own home; a test proves real registrations are untouched.
- [x] 2.16 `ACCEPT-001a1`: `npm run acceptance:native` installs given artifacts in isolation and writes evidence JSON with hashes and versions; dry run in CI without backends.
- [x] 2.17 `ACCEPT-001a2`: the runner drives health, consult, review, session and cancel through the real CLIs; one native run recorded.

Not part of 0.7.0:

- `ACCEPT-001c` (WSL lane, including the POSIX recovery checks of 2.12d) moved to `0.8.0` (owner decision 2026-10-19).

## Delivered

- `npm run acceptance:native` installs a candidate tarball and VSIX in an isolated home and, with `--with-backend-auth`, runs 30 scenario steps through the real Codex, Claude Code and agy CLIs, writing evidence JSON with artifact digests and versions.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#67](https://github.com/oktawianwybieralski/coagent8/pull/67) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_ccb008515f5e408203fb1e71` |
| [#71](https://github.com/oktawianwybieralski/coagent8/pull/71) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_df4bfdc7299be3f838c40677` |
