---
title: DELEGATE-001 in 0.8.0
---

# DELEGATE-001 in 0.8.0: delegation and caller wake-up

Card: [ROADMAP DELEGATE-001](../../ROADMAP.md#delegate-001-asynchronous-delegation-and-caller-wake-up).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#95](https://github.com/oktawianwybieralski/coagent8/pull/95) | `5f770c6` | 2026-10-31 | feat(delegate): delegate code changes to another agent |
| [#105](https://github.com/oktawianwybieralski/coagent8/pull/105) | `3ae31da` | 2026-11-02 | feat(delegate): run delegate asynchronously and wake the caller |

## Scope

- [x] `DELEGATE-001w` - synchronous write delegation (#95).
- [x] `DELEGATE-001c` - portable core contract, as built, with its differences stated in
  [ARCHITECTURE](../../ARCHITECTURE.md#asynchronous-delegation-and-caller-wake-up-delegate-001c).
- [x] `DELEGATE-001e` - asynchronous lifecycle for the write delegation.

Owner decisions 2026-11-01: `async` is the default; asynchronous writes on Windows wait for
`WINDOWS-001b-e`, whose containment parts are delivered; the private Claude pipe stays rejected.

Open: `001a` (an open Codex window and agy, #113; a real client end to end, #115), `001b` (the
caller label is recorded from `CLAUDE_CODE_SESSION_ID` and filters nothing yet, #116), `001d`
(adapters beyond Claude Code's background command, #114) and `001f` (#107, #117).

Owner decision 2026-11-02: the P2 finding that a waiter cannot learn the end of a delegation when
the data directory stays unwritable is deferred to #121, and the P2 finding that a reused PID makes
the record of a dead server look alive is deferred to #122.

## Delivered

- `delegate` returns `task_handle`, `session_handle`, `wakeup` and `wait_argv` once the backend
  turn runs; `mode: "sync"` keeps the earlier contract. A refusal before the turn is the call's
  error.
- One operation owned by the task holds the writer, stops with `cancel` or server shutdown, and
  persists the result before it releases the writer. If the end of the process tree cannot be
  confirmed, the writer stays reserved until the server restarts.
- `coagent8 wait` and `session` action `task` read the result. A running task of a dead server
  reads as `interrupted`.
- A Codex writer on Windows learns that PowerShell runs in ConstrainedLanguage mode.

## Evidence

Native on Windows 11, Node 24.21.0, a fresh server from the bundle with a helper built by the GNU
toolchain, in scratch repositories, with a window observer running (0 console windows):

| Backend | Model | Call returned after | `wait_argv` as a process | Cancel of a running task |
| --- | --- | --- | --- | --- |
| Codex | `gpt-6.1-terra` | 1.5 s, file not yet there | exit 0, file and observed changes | `cancelled` in 1.0 s, writer free |
| Claude Code | `claude-haiku-5-5` | 3.0 s, file not yet there | exit 0, file and observed changes | `cancelled` in 1.1 s, writer free |
| agy | `gemini-3.8-flash-high` | 2.5 s, file not yet there | exit 0, file and observed changes | `cancelled` in 0.4 s, writer free |

Independent review of #105 at its merged head `b421129`: Codex BLOCKED, one P2 (#121); agy not run on
that head because of its quota, READY at `a608929`. The owner merged in that state. The P2 found after
the merge, that the first Git read of an asynchronous delegation escaped its budget, is fixed in the
next PR.

Not observed end to end: an installed package in a real client starting `wait_argv` by itself. The
client's half, a background command waking Claude Code when it exits, was observed separately.

## Server-owned loop, first slice (2026-11-02)

`DELEGATE-001f2`, ahead of `COAGENT-002` to `004` by owner decision 2026-11-02: `delegate` with
`loop: true` runs user-approved `checks` outside any sandbox, then a read-only review on another
backend, and returns failures to the worker for at most two fix rounds, with the writer held.

Native, a fresh server from the bundle, the check in `allowedChecks` of an isolated configuration:

| Writer | Task | Loop | Review | Own run of the check |
| --- | --- | --- | --- | --- |
| Codex `gpt-6.1-terra` | fix a real bug in `add.js` | `passed`, no fix round | READY by Claude Code `claude-opus-5-5` | exit 0 |
| Claude Code `claude-haiku-5-5` | add a comment, while the check needs a bug fixed that the task does not name | `review_blocked` after 2 fix rounds | BLOCKED by Codex `gpt-6.1-terra` | exit 0 |

The second run shows both ends of the rounds: the check failed on the first turn and a fix round made it
pass, and the review then blocked because the change went beyond the task, so the bound ended the loop
with the failure reported. The same task on an earlier build ended `checks_failed`: the worker undid its
fix on the review's finding, so a model may land on either side of this conflict.

An earlier run ended `review_failed` on agy's quota, so the review now moves on from a backend out of
quota.

Not run: the form in a real client, agy as a writer in the loop, POSIX natively.
