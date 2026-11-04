---
title: Handoff notes for 0.8.0
---

# Handoff notes for 0.8.0

Moved unchanged except for link paths from [HANDOFF.md](../../HANDOFF.md) on 2026-11-03, when it was cut back to the
current state. History, not instructions. The card records in this directory are the reviewed account.

- **Server-owned loop (`DELEGATE-001f2`, owner decision 2026-11-02):** merged in #126 (`02e3b5f`).
  `delegate` with `loop: true` runs checks, an independent review and bounded fix rounds with the writer held. Contract:
  [ARCHITECTURE](../../ARCHITECTURE.md#asynchronous-delegation-and-caller-wake-up-delegate-001c).

- **Check approval in real clients (2026-11-03, #135):** neither Claude Code 2.1.317 in VS Code
  (`decline`) nor Codex 0.164.0-alpha.11.1 (`cancel`) shows the form for `loop` checks, so the loop
  runs in those clients only with its checks in `allowedChecks`. The refusal now says that the
  client answered, not the user. A declined model approval form is still reported as the user's
  refusal; that is tracked in #140.

- **Acceptance in a real client (2026-11-02):** on the CI-built VSIX, Claude Code delegated to Codex
  and Claude Code and was woken with the results; cancel left nothing running. agy passed the same
  checks from that package, with its MCP servers at cancel and at the deadline (#109, #110).
  Records: [DELEGATE-001](../../delivered/0.8.0/DELEGATE-001.md), [WINDOWS-001](../../delivered/0.8.0/WINDOWS-001.md).

- **Asynchronous delegate (`DELEGATE-001c`, `e`, owner decisions 2026-11-01):** merged in #105
  (`3ae31da`) at `b421129`; the commits pushed after that merge continue in the next PR. `delegate` is
  asynchronous by default, `coagent8 wait` and `session` action `task` read the result. Claude
  Code gets `background_wait`; Codex and agy get `none` until `001a` proves their wake-up.

- **Windows native acceptance (`WINDOWS-001e`, first pass 2026-11-01):** merged in #105. All three backends wrote through the helper, left no
  survivor after a cancel and showed no console window. The open items are on the card. Next:
  `DELEGATE-001a`. Record: [WINDOWS-001 in 0.8.0](../../delivered/0.8.0/WINDOWS-001.md).

- **Answer language (owner decision 2026-11-01):** merged in #104 (`c50def0`).
  Backends followed the workspace's rule to answer the owner in Polish, inconsistently. The
  server now asks for English before every backend prompt (`answerLanguage`), and the calling
  agent relays. CI also builds the `arm64` helper with `--verify`, which only a tag did before.

- **Windows per-call containment (`WINDOWS-001b-d`, owner decisions 2026-11-01):**
  `001b` and `c` merged in #102 (`6161449`), `001d` in #103
  (`68d7d56`). `delegate` becomes asynchronous by default in 0.8.0,
  and asynchronous writes on Windows wait for `WINDOWS-001b-e`. The package carries the helper
  unsigned, with its digest checked before launch, and `delegate` refuses to run on Windows
  without it. Next: `001e`, then `DELEGATE-001`. Record:
  [WINDOWS-001 in 0.8.0](../../delivered/0.8.0/WINDOWS-001.md).

- **CodeQL alerts and CI timing (2026-11-01):** merged in #101 (`696f6b1`).
  Alert 1: `ci.yml` limits the token to `contents: read`. Alert 2: the Windows
  shim check in `src/execution/cli-resolver.ts` consumes the redirections after
  `%*` with a sticky tokenizer instead of removing them with `replace`; the
  decision is unchanged (the new shim test passes on the old code). Alert 3: the
  opener test checks the URL as an exact argument. Two timing tests failed on
  loaded runners after #98: AUDIT-001-A12 now counts the 20 attempts instead of
  wall time, and the sanitizer ReDoS test compares a 16x larger input (linear
  16x, quadratic 256x) instead of 4x.

- **Formatter (`FORMAT-001`, owner decisions 2026-10-31):** merged in #98
  (`e91b598`). Prettier, line width 140, formats TypeScript,
  JavaScript, JSON and YAML; Markdown keeps its layout. CI runs
  `npm run format:check`. The reformat needed two source fixes: the branding
  generator now writes the formatted layout, and the VS Code command test no
  longer depends on line breaks. `.git-blame-ignore-revs` lists the squash
  commit. Record:
  [FORMAT-001 in 0.8.0](../../delivered/0.8.0/FORMAT-001.md).

- **PEM redaction ReDoS (CodeQL alert 4, `js/polynomial-redos`, #99, `a778caa`):** the PEM
  private-key pattern in `src/security/redaction.ts` allowed a hyphen in the
  key type, so repeated `-----BEGIN ` or `-----END ` markers backtracked
  quadratically (4.7 s on 220 KB). The key type is now bounded to 40
  characters, hyphens included, so each marker costs constant work (7 ms on
  the same input); every key type that matched before and fits the bound
  still matches, and a regression test bounds the time.

- **Agent standards (owner request 2026-10-31, `STANDARDS-001a`):** merged in
  #97 (`ca9c793`). `agent-standards.mjs sync --ref v0.1.0` copied the
  core rules and scripts (commit `e69b2d0`); `check` matches the lock. The
  character check found 204 forbidden characters in 34 files. Most of them
  were the middle dot in CoAgent8's own output (result footer, usage line,
  doctor, session list, VS Code UI), now `-` (owner decision 2026-10-31). The
  Claude `/usage` parser accepts any one separator character, because Claude
  prints a middle dot. The recorded Claude CLI output in
  `tests/fixtures/claude-cli/recordings/` stays verbatim and excluded with its
  reason. #94 is resolved by core rule 02 (merge only on the owner's explicit
  instruction for that PR). Record:
  [STANDARDS-001 in 0.8.0](../../delivered/0.8.0/STANDARDS-001.md).

- **Open issues on the 001w branch (owner request 2026-10-31):** the owner asked
  to fix the open issues first and then work toward `0.8.0` with a complete
  `delegate`. The plan was consulted with Codex (`gpt-6.1-terra`, session
  `syn_sess_ccae8fe748eb3980edc63618`) and agy (`gemini-3.8-flash-high`,
  `syn_sess_d57de691433d03b7f179edc4`). Owner decision on #94: rule 02's
  wording applies, and an agent merges only on the owner's explicit instruction
  for that PR. The rule files change together with the adoption of
  `agent-standards` v0.1.0.
  - #92: reproduced natively (Windows 11, agy 1.4.12, `gemini-3.8-flash`
    medium) in a local clone of this repository. `delegate` failed with
    `POLICY_DENIED` after 268 s and 42 operations, with no change. A direct agy
    run with the same flags showed the cause: `denied_actions` named
    `read_file`, a read of the clone's origin checkout outside the workspace,
    not a shell command. agy's own consultation had claimed that directory
    listing runs through `run_command`, but no run showed that. One more turn
    in the same agy conversation, which named the workspace, finished the edit.
    The fix names denied actions (identifiers only) in the error and the
    history warning, keeps the writer inside the workspace in its prompt, and
    sends one writer recovery turn. A native run of the built server then
    completed the same task with one changed line (404.5 s, no denial). A small
    scratch repository never reproduced the failure.
  - #89: two direct agy runs that asked for oversized answers were refused by
    the model, so the limit was not reproduced natively. The fix uses the error
    text from the issue: a partial answer at the output token limit becomes a
    completed result with `lengthLimited: true` and a warning. Without a
    partial answer it stays `PROCESS_ERROR` with guidance. `finish_reason:
    MAX_TOKENS` is accepted as agy described it but has not been observed.
  - #62: every review round now asks for all P1/P2 findings in the whole diff,
    and a follow-up round re-reviews the whole diff. A native Codex consult
    (codex-cli 0.164.0-alpha.11.1, unelevated sandbox, `gpt-6.1-terra`,
    `syn_sess_47027532bc6a6a16ef5029c4`) read its `context_files` without a
    denial and ran `git status`.

- **DELEGATE-001w synchronous write delegation (owner request 2026-10-21):** on
  branch `fix/codex-windows-sandbox-backend`, in its own commit after the sandbox fix.
  Native runs on Windows through CoAgent8 in a scratch repository (codex-cli
  0.162.0-alpha.17.2, Claude Code 2.1.300, agy 1.4.4): Codex (gpt-6.1-sol) and
  Claude (claude-opus-5-5) each added a function with a test and were denied a
  write one level above the workspace (Codex by its sandbox, Claude by
  `--restricted`); Claude ran `npm test` (PASS); Codex could not, because
  inside its Windows sandbox every process started from Node fails with
  `spawn EPERM` (reproduced with `codex sandbox`: node to node and node to
  cmd). agy without `--sandbox` denied every command in headless mode and
  changed nothing; with `--mode accept-edits` and the write note it added the
  function and tests and reported `npm test` as NOT_RUN; the tests passed when
  run by the caller (5/5). The "Observed by CoAgent8" block matched each diff,
  including the warning for files dirty before the turn. Claude Code sent two
  parallel delegate calls one after the other, so the single-writer refusal is
  covered by tests across server processes with different data directories,
  not natively. Independent review (Codex, handle
  `syn_sess_a3dd10933437bf6e4860fada`): BLOCKED in rounds 1 and 2 (redaction,
  evidence completeness, existence inference, writer record reads), READY in
  round 3 with one P3 documentation fix applied.

- **Codex Windows sandbox backend (owner decision 2026-10-21):** branch
  `fix/codex-windows-sandbox-backend`. On codex-cli 0.162.0-alpha.17.2, `codex
  sandbox` with `read-only` and `windows.sandbox="elevated"` ran as
  `CodexSandboxOffline` and could not read `assets/` (protected ACL without
  `CodexSandboxUsers`), so `git status` listed its 25 tracked files as deleted;
  with `windows.sandbox="unelevated"` the same commands read all 25 files, ran Git
  and Node, and a write in the workspace was denied (`workspace-write`: written
  inside, denied outside). Through `app-server` every command first failed with
  `CreateProcessAsUserW` error 5: Codex starts the first `pwsh.exe` on `PATH`, a
  Microsoft Store alias that a restricted token cannot start (directly from the
  package directory neither). With that directory removed from the server's
  `PATH`, `allow_login_shell=false` and the owner's PowerShell 7.6.7 from Scoop,
  a CoAgent8 consult on gpt-6.1-sol ran PowerShell 7.6.7, read `assets/` (25),
  reported a correct `git status`, printed no profile errors and was denied the
  write probe (16.2 s, 4 operations; handle `syn_sess_59b59a2e22e834dac9f131e5`).
  Not run: an isolated `CODEX_HOME` (lane 4 of 2.12d) and POSIX, which is unchanged.

- **DELEGATE-001 asynchronous plan (owner request 2026-10-21):** prose only,
  no code. Using `001w` from Claude Code needs a Claude subagent that only
  waits on the blocking call, so `delegate` is to return at once and wake the
  caller. Codex consultation `gpt-6.1-sol`, session
  `syn_sess_973e692be03b734e8b5fdbaa` (243.5 s); its findings were checked
  in `src/mcp/server.ts` (request-owned signal and budget),
  `src/execution/delegation.ts` (writer released when the request ends) and
  `src/sessions/writer.ts` (takeover of a record whose process is gone). The
  Claude Code channels documentation was read on 2026-10-21. A Bash tool
  process of the Claude Code VS Code extension 2.1.306 had
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and a private
  `CLAUDE_CODE_MESSAGING_SOCKET`; the MCP server process was not checked.
  Draft contract in
  [ARCHITECTURE](../../ARCHITECTURE.md#asynchronous-delegation-and-caller-wake-up-delegate-001c);
  re-scoped cards and four open owner decisions in the
  [DELEGATE-001 card](../../ROADMAP.md#delegate-001-asynchronous-delegation-and-caller-wake-up).
  Not reviewed yet.
