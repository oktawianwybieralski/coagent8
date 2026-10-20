---
title: ENVELOPE-001 in 0.7.0
---

# ENVELOPE-001 in 0.7.0: server-owned review terminator

Card at closure: [ROADMAP ENVELOPE-001 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#envelope-001-server-owned-review-terminator); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#72](https://github.com/oktawianwybieralski/coagent8/pull/72) | `ea73af5` | 2026-10-19 | fix(review): own the envelope terminator on the server |

## Scope at closure

Each item was met in the merges above.

- [x] 2.12e `ENVELOPE-001a`: the gate accepts a complete envelope without `END_REVIEW` only on completion evidence and the server appends it; a length stop blocks; tests (owner decision 2026-10-18).

Not part of 0.7.0:

- `ENVELOPE-001b`: Codex and agy report no stop reason, so a cut-off answer that already wrote `CHECKS` cannot be detected for them.

## Delivered

- The review envelope ends with `CHECKS`; the server appends `END_REVIEW` when the turn completed untruncated, and a Claude length stop blocks and leaves the review retryable.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#72](https://github.com/oktawianwybieralski/coagent8/pull/72) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_31642e43b226be30e348a243` |
