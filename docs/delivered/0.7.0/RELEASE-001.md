---
title: RELEASE-001 in 0.7.0
---

# RELEASE-001 in 0.7.0: automated publication

Card at closure: [ROADMAP RELEASE-001 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#release-001-automated-publication); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#35](https://github.com/oktawianwybieralski/coagent8/pull/35) | `14f7362` | 2026-10-13 | build(ci): use script with relative path for npm publish and test in CI |
| [#73](https://github.com/oktawianwybieralski/coagent8/pull/73) | `3065ac9` | 2026-10-19 | ci(release): build the release notes from a reviewed header file |
| [#74](https://github.com/oktawianwybieralski/coagent8/pull/74) | `5236bf2` | 2026-10-19 | ci(npm): stage releases on next through trusted publishing |
| [#75](https://github.com/oktawianwybieralski/coagent8/pull/75) | `c0f2ed1` | 2026-10-19 | ci(marketplace): publish the release VSIX in the normal channel |
| [#76](https://github.com/oktawianwybieralski/coagent8/pull/76) | `fcf15d1` | 2026-10-19 | ci(release): verify the published packages against the release files |
| [#77](https://github.com/oktawianwybieralski/coagent8/pull/77) | `7d5fd60` | 2026-10-19 | docs(rules): describe the automated release phases |
| [#83](https://github.com/oktawianwybieralski/coagent8/pull/83) | `f0de595` | 2026-10-19 | fix(release): publish verified packages directly to next |
| [#84](https://github.com/oktawianwybieralski/coagent8/pull/84) | `00eb614` | 2026-10-19 | docs(release): record manual Marketplace publication for 0.7.0 |

## Scope at closure

Each item was met in the merges above.

- [x] 1.3 `RELEASE-001a`: `npm-publish.yml` uses `./release/...` through a script that CI runs with `npm publish --dry-run` on a packed tarball.
- [x] 5.1 `RELEASE-001b1`: the workflow runs `npm publish <verified tarball> --tag next` through trusted publishing with provenance; dry-run check in CI (owner decision 2026-10-19).
- [x] 5.3 `RELEASE-001c`: drafts are normal releases; Marketplace without `--pre-release`; npm stays on `next` with the owner's promotion to `latest`.
- [x] 5.4 `RELEASE-001d`: the Marketplace job is implemented; for 0.7.0 the owner uploads the exact verified VSIX manually and the job stays disabled (owner decision 2026-10-19).
- [x] 5.6 `RELEASE-001e`: `docs/releases/vX.Y.Z.md` is required by `release.yml`; expanded changelog; area names mapped.
- [x] 5.7 `RELEASE-001f`: a job compares registry and Marketplace files with the release files.
- [x] 5.8 `RELEASE-001g`: rule 02 describes the automated phases.

Not part of 0.7.0:

- `RELEASE-001b2`: the owner creates the npm trusted publisher on release day.

## Delivered

- A tag builds a verified draft release with notes from `docs/releases/`; publishing the draft publishes the exact verified tarball to npm `next` with provenance, and **Verify published** compares the registry and Marketplace files with the release files.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#35](https://github.com/oktawianwybieralski/coagent8/pull/35) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_79e296dbcd0331eac28b2200` |
| [#73](https://github.com/oktawianwybieralski/coagent8/pull/73) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_59167abf8e266381905d80b5` |
| [#74](https://github.com/oktawianwybieralski/coagent8/pull/74) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_4d2f721cfc0bc29d178f880e` |
| [#75](https://github.com/oktawianwybieralski/coagent8/pull/75) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_f14b3080f00907ce909d28fb` |
| [#76](https://github.com/oktawianwybieralski/coagent8/pull/76) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_708740f1098910671836ba05` |
| [#77](https://github.com/oktawianwybieralski/coagent8/pull/77) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_ec88ffac004f10bc316a81e9` |
| [#83](https://github.com/oktawianwybieralski/coagent8/pull/83) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_b8101fd87f1d7fc6073c983b` |
| [#84](https://github.com/oktawianwybieralski/coagent8/pull/84) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_b8101fd87f1d7fc6073c983b` |
