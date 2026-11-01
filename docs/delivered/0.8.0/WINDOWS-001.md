---
title: WINDOWS-001 in 0.8.0
---

# WINDOWS-001 in 0.8.0: per-call process containment

Card at closure: [ROADMAP WINDOWS-001](../../ROADMAP.md#windows-001-per-call-process-containment).
The PR's number and squash commit are filled in once known ([rules](../README.md#rules)).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| pending | pending | pending | feat(windows): end a cancelled run's whole process tree |

## Scope at closure

- [x] `WINDOWS-001b` - launcher contract. Check: P.
- [x] `WINDOWS-001c` - implement the helper. Acceptance: fixture trees, breakaway
  requests, root exit and helper teardown match the contract. Check: R, PROCESS/LIFE plus
  helper tests.

Owner decisions 2026-11-01: `delegate` is asynchronous by default in 0.8.0, and
asynchronous writes on Windows do not ship before `WINDOWS-001b-e`.

Not part of this record:

- `WINDOWS-001d` (packaging, digests) and `WINDOWS-001e` (native acceptance per backend,
  browsers, Git credential helpers, quiet desktop observed with a window hook) stay in the
  ROADMAP. Until `001d`, an installed CoAgent8 runs without the helper.

## Delivered

- [`native/coagent8-job`](../../../native/coagent8-job/src/main.rs): one job per run, atomic
  job assignment, status line, stop over the status pipe, and exit only once the job is
  empty ([contract](../../ARCHITECTURE.md#windows-per-call-containment-windows-001)).
- `src/execution/process.ts` starts every Windows run through the helper when it is present
  and maps a failed start to a typed error.
- CI builds the helper on Windows, so the `WINDOWS-001a` observation is a required test
  there instead of a todo.

## Evidence

Native on Windows 11, Node 24.21.0, GNU toolchain build: arguments, exit codes, large final
output, failed starts, stop through the pipe and through termination, root exit, a pipe
holder, Git and npm inside the job, and a denied breakaway request (`ERROR_ACCESS_DENIED`).
Launch overhead about 25 ms (median of 15). Reviews and CI are in the PR body; the next PR
moves them here.
