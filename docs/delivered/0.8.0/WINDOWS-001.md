---
title: WINDOWS-001 in 0.8.0
---

# WINDOWS-001 in 0.8.0: per-call process containment

Card at closure of `001b` and `c`: [ROADMAP WINDOWS-001 at `6161449`](https://github.com/oktawianwybieralski/coagent8/blob/6161449eb6f4918e871ad4a7dce3e3c815263862/docs/ROADMAP.md#windows-001-per-call-process-containment).

## Merges

| PR | Squash | Merged | Title |
| --- | --- | --- | --- |
| [#102](https://github.com/oktawianwybieralski/coagent8/pull/102) | `6161449` | 2026-11-01 | feat(windows): end a cancelled run's whole process tree |

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
  job assignment, a status pipe that also confirms the end of the tree, and a stop pipe ([contract](../../ARCHITECTURE.md#windows-per-call-containment-windows-001)).
- `src/execution/process.ts` starts every Windows run through the helper when it is present,
  maps a failed start to a typed error and reports `treeEnded`.
- CI builds the helper on Windows, so the `WINDOWS-001a` observation is a required test
  there instead of a todo.

## Evidence

Native on Windows 11, Node 24.21.0, GNU toolchain build: arguments, exit codes, large final
output, failed starts, stop through the pipe and through termination, root exit, a pipe
holder, Git and npm inside the job, and a denied breakaway request (`ERROR_ACCESS_DENIED`).
Launch overhead about 25 ms (median of 15).

CI of #102: six test jobs including the MSVC helper build, Analyze and CodeQL passed.
Review rounds: Codex BLOCKED twice (the fallback could end the helper before it confirmed
the empty job; an installed package could run an executable planted in `node_modules`; the
CI build skipped the static C runtime configuration), all fixed; agy READY in every round
and did not report these. CodeQL alert 6 in a test fixture was fixed as well.

| Reviewer | Head | Verdict | Handle |
| --- | --- | --- | --- |
| codex | `9582a75` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_646758006e9f89ebb2466015` |
| agy | `9582a75` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_de86b44065f852373e73c0cd` |

## WINDOWS-001d

- [x] `WINDOWS-001d` - package and verify the helper, delivered unsigned. `001d1` (signing,
  owner) and `001e` stay in the ROADMAP.

Delivered:

- `scripts/build-job-helper.cjs` builds `x64` and `arm64` with the compiler pinned in
  `native/coagent8-job/rust-toolchain.toml`; `--verify` requires two identical builds.
- `scripts/build.cjs` takes staged helpers into `dist/win32-<arch>/` and embeds their digests;
  the release workflow requires both architectures.
- The VSIX carries the helpers, and setup copies the machine's helper beside each runtime copy
  of the bundle, which is what clients start.
- A changed or unknown helper is refused, and `delegate` then fails with
  `SANDBOX_UNAVAILABLE` on Windows.

Merged as [#103](https://github.com/oktawianwybieralski/coagent8/pull/103), squash `68d7d56`, 2026-11-01:
`feat(windows): ship the job helper and refuse delegate without it`.

Evidence on Windows 11, Node 24.21.0, with a GNU-toolchain helper staged by hand: the full gate at
`932c120` (956 tests, 953 pass, 0 fail, 3 skipped), `test:consumer` at `0badd7e` with `doctor` and
`delegate` refusing a changed helper on the installed package. CI: the MSVC x64 build with
`--verify` and all jobs passed. Not run: `release.yml`, `arm64`, SmartScreen and Defender.

Review rounds: Codex BLOCKED in three rounds (digest checked once per process, damaged copies not
repaired, a launch without a helper after the first check, an unreadable helper throwing, a smoke
test that checked only `doctor`), agy BLOCKED once (`upload-artifact` skipping dot-prefixed paths);
all fixed.

| Reviewer | Head | Verdict | Handle |
| --- | --- | --- | --- |
| codex | `0badd7e` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_b4a6951f2f5efbd5216efcf0` |
| agy | `0badd7e` | READY, coverage COMPLETE, no unresolved P1/P2 | `syn_sess_9cb026053054451322f0c748` |

## WINDOWS-001e, first pass (2026-11-01)

Windows 11, Node 24.21.0, a fresh server from the built bundle with a helper built by the GNU
toolchain, in scratch repositories. A `SetWinEventHook` observer logged new top-level windows; an
off-screen control window proved that it records them.

| Backend | Model | `delegate` wrote the file | Tree after a cancelled consult | Console windows |
| --- | --- | --- | --- | --- |
| Codex 0.164 | `gpt-6.1-terra` | yes, after the fix below | no survivor | none |
| Claude Code | `claude-haiku-5-5` | yes | no survivor | none |
| agy | `gemini-3.8-flash-high` | yes | no survivor | none |

The tree was observed by a read-only process snapshot and was gone within about two seconds, a
figure that includes the half-second polling. MCP sends no response to a cancelled request, so no
return time was measured.

Inside the job, also without any window: Chrome `--headless=new`, `git ls-remote` over HTTPS and
Git Credential Manager `--version`. Defender: real-time protection on, no detection of the helper.

The first run found that Codex wrote nothing on Windows, with and without the helper: its sandbox
runs PowerShell in ConstrainedLanguage mode, and the worker took the resulting error for a denial.
A Windows writer now gets a note about it.

Open: a CI-built helper in an installed VSIX in a real client (#109), a real CLI's own descendants
at cancel, none of which ran in these turns, expiry and the cold agy updater (#110), `arm64` and
SmartScreen on a file with Mark-of-the-Web (#111).
