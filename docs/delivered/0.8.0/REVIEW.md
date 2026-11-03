---
title: REVIEW in 0.8.0
---

# REVIEW in 0.8.0: large changes and server-run checks

Cards: `REVIEW-002` and `REVIEW-003` in the
[ROADMAP 0.8.0 plan](../../ROADMAP.md#080-plan). Contract:
[ARCHITECTURE, Review contract](../../ARCHITECTURE.md#review-contract).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#145](https://github.com/oktawianwybieralski/coagent8/pull/145) | `b0ece34` | 2026-11-03 | feat(review): review changes too large for one turn in parts |
| [#146](https://github.com/oktawianwybieralski/coagent8/pull/146) | `3f7994c` | 2026-11-03 | feat(review): run approved checks on the reviewed change |

## Scope

- [x] `REVIEW-002` - a diff above 200,000 characters is reviewed in parts, each in its own
  session, then in one synthesis turn over their findings (#145). Owner request 2026-11-03,
  after consulting Codex and agy on keeping the diff in the prompt.
- [x] `REVIEW-003` - the reviewer stays read-only; `review.checks` run by the server on the
  reviewed change before the turn (#146). Owner decision 2026-11-03 ("checks plus read access",
  not an unsandboxed reviewer).

Open: parts run one after another and were run natively only on Codex; the usage line counts
the synthesis turn only.

## Delivered

- `src/review/parts.ts` splits the collected diff at file, hunk, line and code-point
  boundaries, with each piece's file header; untracked files are cut where the collector
  recorded them (`GitScopeInfo.untracked`).
- `review` runs each part in a fresh session bound to `<snapshot>/part-n-of-total`, then a
  synthesis turn bound to the whole snapshot. The verdict stays BLOCKED unless every part
  ended READY; more than 15 parts (`MAX_REVIEW_PARTS`) refuse the review before any turn.
- `review.checks` are approved like those of the `delegate` loop (an exact `allowedChecks`
  entry or the user's form), run in the work tree that holds the reviewed state, and the
  snapshot and work tree are checked after every check. A check that does not pass blocks
  (`ReviewGateContext.serverChecks`); a review with checks is never answered from an earlier
  verdict.

## Evidence

Windows 11, Node 24.21.0, a fresh server from each branch's bundle, Codex `gpt-6.1-terra`:

| PR | Native run | Result |
| --- | --- | --- |
| #145 | an uncommitted change of about 450,000 characters with one planted bug | 3 parts in 75 s; part 2 found the bug, the synthesis repeated it; BLOCKED |
| #146 | a change that broke `add.js`, `node test.js` in `allowedChecks` | the server ran the check; BLOCKED with "A check the server ran did not pass" |

Gates: #145 at `a577b90` (1038 tests, 1030 pass, 8 skipped), #146 at `7c3d7b9` (1042 tests,
1034 pass, 8 skipped), each with the full rule 14 gate.

| PR | Reviewer | Verdict | Head | Handle |
| --- | --- | --- | --- | --- |
| #145 | Codex | READY, complete coverage, after 1 P1 and 13 P2 fixed over six rounds | `a577b90` | `syn_sess_35938885d31261681967a67f` |
| #145 | agy | FAILED, deadline of 900 s after 71 operations | `a577b90` | `syn_sess_bf86938a9ccc48716d644a3c` |
| #146 | Codex | READY, complete coverage, after 3 P1 and 7 P2 fixed over four rounds | `7c3d7b9` | `syn_sess_db8c1bb9055a1a75cf1d64da` |
| #146 | agy | NOT_RUN | - | - |
