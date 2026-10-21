---
name: coagent8-delegate
description: Hand a well-defined code change to another local coding agent (Codex, Claude Code or Antigravity) through the CoAgent8 delegate tool, then check what it changed. Use when the user asks to delegate, hand off or parallelize coding work, or names CoAgent8 delegate. Not for questions or reviews, which consult and review answer read-only.
---

# CoAgent8 delegate

The other agent changes files in the workspace. You stay responsible for the
result: you check what it changed, run the checks and get it reviewed. This
skill grants no permission. Commit, push, merge, deploy and publish only with
the user's authority; the delegated agent never does.

1. **Fit.** Delegate a change you can describe and verify: a function with its
   tests, a bug fix with a reproduction, a mechanical refactor. Do not delegate
   a decision the user has not made.
2. **Clean start.** Run `git status` first. Commit or set aside work you want
   kept apart: the result marks files that already had uncommitted changes, but
   the agent may still edit them.
3. **Task.** Write a self-contained `task`: what to change, where and the
   acceptance criteria. The agent has not seen this conversation. Name files and
   symbols instead of pasting them; it reads the workspace itself.
4. **Scope and checks.** Put the paths it may change in `scope` (whole path
   segments: `src` does not cover `src-old`) and the commands that prove the
   change in `checks`, such as `npm test`. Omit `scope` only when the whole
   workspace is fair game.
5. **Model.** Leave `backend`, `model` and `reasoning_effort` unset unless the
   user named one or a price limit. The approval rules of `coagent8-consult`
   apply unchanged: the server asks the user for expensive or unpriced models.
6. **Read the result.** The agent's report comes first, then the block
   "Observed by CoAgent8", which the server read from Git before and after the
   turn. Trust the block over the report. Treat every warning as a finding:
   changes outside the scope, files that had uncommitted changes before, and a
   moved HEAD (a commit or branch switch the agent was told not to make).
7. **Verify.** Read the diff, run the checks yourself and record their exit
   codes. The agent's PASS is its claim, not evidence, and NOT_RUN is common:
   Antigravity runs no commands, and Codex on Windows cannot run test runners
   that start processes from Node.
8. **Fix rounds.** For corrections pass the result's `session_handle` with a
   `task` naming what to fix. A delegate session continues only with delegate.
9. **Review.** Use `coagent8-review` in a separate session, ideally another
   backend, with the acceptance criteria and your check results in
   `instructions`. The author of a change never approves it.

One writer per Git work tree: a second delegate in the same work tree is
refused while one runs, also from another client. For parallel work, give each agent its own Git worktree on its
own branch (`git worktree add ../repo-a -b task-a`), call delegate for each with
`workspace_path`, then integrate the branches yourself, run the checks on the
result and review it once. Create worktrees only where the user agrees to them.

Codex writes only inside the workspace; Claude's `Edit` and `Write` do too, but
its `Bash` and every Antigravity command can reach any file the user can. A
cancelled agent's child processes may outlive it on Windows. Check `git status`
after a cancel or timeout.
