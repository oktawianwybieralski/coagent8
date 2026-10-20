---
title: AUDIT-001 in 0.7.0
---

# AUDIT-001 in 0.7.0: corrected analysis follow-up

Card at closure: [ROADMAP AUDIT-001 at `00eb614`](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#audit-001-corrected-analysis-follow-up); task rows in [TASKS-070](https://github.com/oktawianwybieralski/coagent8/blob/00eb614d7c4f9ae26ba6fd945f6cd854ba4c0b8e/docs/ROADMAP.md#tasks-070-070-task-queue).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#80](https://github.com/oktawianwybieralski/coagent8/pull/80) | `4e3737d` | 2026-10-19 | fix: retry setup writes, bound the observation cache and read history tails backward |

## Scope at closure

Each item was met in the merges above.

- [x] 2.29 `AUDIT-001-A08` to `A21`, in card order and grouping; a reproduction that finds no defect skips its fix.

## Delivered

- A08: no defect, so A09 was skipped. A10-A12: client file replacements that Windows refuses for a moment are retried, never over a concurrent edit. A13-A15: the model observation cache is capped at 100 entries. A16-A18: history tails are read backward in 8 KiB blocks. A19: redaction of free-text reports stays conservative, so A20 was skipped. A21: outcomes recorded.

## Evidence

Each PR body records the author checks (commands with PASS, FAIL or NOT_RUN, platform and Node version) and the review rounds. The final independent review of every merge:

| PR | Final independent review |
| --- | --- |
| [#80](https://github.com/oktawianwybieralski/coagent8/pull/80) | READY, coverage COMPLETE, no unresolved P1/P2; `syn_sess_b1a6bc88cb47c8d07a2e0ba4` |

## Notes

- Windows sharing violations were simulated in tests, not observed natively.
