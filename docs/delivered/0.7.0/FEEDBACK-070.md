---
title: FEEDBACK-070 in 0.7.0
---

# FEEDBACK-070 in 0.7.0: findings of the 0.7.0 native acceptance

Merge: PR [#86](https://github.com/oktawianwybieralski/coagent8/pull/86), squash
`87c7b13`, 2026-10-20.

Card at closure: [ROADMAP FEEDBACK-070 at `87c7b13`](https://github.com/oktawianwybieralski/coagent8/blob/87c7b13e0cc4b56eb48a9438055cb0c386b4c563/docs/ROADMAP.md#feedback-070-findings-of-the-070-native-acceptance)
and task row 5.10a.

## Scope at closure

Native acceptance of the release PR #85 candidate on 2026-10-20 (Codex, Claude
Code and Antigravity in VS Code on Windows, runtime from the CI VSIX) passed
every scenario; these findings were fixed before the tag (owner direction
2026-10-20, consulted with Codex).

- [x] `FEEDBACK-070a`: a P1/P2 finding header written without brackets blocks
  READY and BLOCKED answers; prose, P3 and `P20` do not.
- [x] `FEEDBACK-070b`: cache writes are priced by how long they are kept; a turn
  that reached the list's prompt-size tier shows counts only; agy, which reports
  no cache counts, shows counts only.
- [x] `FEEDBACK-070c`: sessions of a deleted workspace can be listed, read and
  closed; ownership is still checked.
- [x] `FEEDBACK-070d`: binary changes are named instead of making the input
  PARTIAL; their content is bound into the snapshot and READY states how many were
  not reviewed (owner decision 2026-10-20).

Not part of 0.7.0: slow agy reviews with an unnamed sandbox denial, the
closed-session footer `CLI - provider default`, and setup status counting a manual
registration of another runtime as registered. They are candidates for 0.8.0.

## Delivered

- The review gate treats a line that, after Markdown list, quote, heading or
  emphasis marks, opens with P1 or P2 and cites a `<file>:<line>` as a finding.
- The `Usage:` footer prices regular input, cache reads, cache writes kept for
  minutes or an hour and output, each once, from the exact price-list match; a
  stored price list without the new fields withholds amounts until it is read again.
- `session` accepts an absolute `workspace_path` that no longer exists.
- Reviews of branches that change images or other binary files can reach READY;
  binary files come from Git's machine-readable output, their Git blob ids (index
  and working tree, hashed unfiltered, regular files only) bind the snapshot, and a
  binary without an identity keeps the input PARTIAL.

## Evidence

- Native acceptance (2026-10-20): release PR #85 at `4590d34`, CI run
  `39327153830`, CI VSIX SHA-256
  `0ebb354e98f7da94b131c10a0870aaba498866220b814ca3c16d3ddbb06c6390`, runtime
  `2e0828374cc8b088eefda0dd32e6a1707cf7b6ced0aa9508db1a1cba712fc043`; all three
  clients passed issue, doctor, consult with continuation, seeded-defect review
  BLOCKED then READY, session list/history/cancel and the closed-session refusal.
- Author checks on the final head `8db0595`, Windows 11, Node 26.10.0: typecheck,
  dependency boundaries, TSDoc lint, TypeDoc and build PASS; `npm test` 919 tests,
  915 pass, 0 fail, 3 skipped, 1 todo; each regression fails without its fix. The
  symlink regression runs only where symlinks are permitted (POSIX CI). PR CI on
  that head passed all six jobs; the first PR CI run had failed the deleted-workspace
  test on macOS and Windows (a deleted path below a symlink or an 8.3 short name
  changed identity), fixed in `8db0595`.
- Live check: on a branch that deletes two JPEG files, collected input changed
  from PARTIAL to COMPLETE with both files named.
- Independent review: READY on `8db0595`, coverage COMPLETE, no unresolved P1/P2;
  `codex` / `gpt-6.1-sol`, `syn_sess_bd8aee068965674f12a5d440` turn 8 (turn 7 was
  READY on `c00c806` before the CI fix). Rounds 1-6
  found and fixed: bold, list, heading and backticked headers; a sole one-hour write
  price; binary entries parsed from diff text (path injection, quoted names,
  subdirectory paths, unbounded reads); index-only changes, clean filters and
  symlinks; working bytes Git normalizes to the index.
- Re-acceptance of the rebuilt artifacts is release evidence for the rebased #85.
