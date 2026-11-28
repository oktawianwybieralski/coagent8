---
name: coagent8-coordinate
description: Coordinate work across roles with CoAgent8 so your session leads, another agent implements and a third reviews - writing a self-contained task spec, checking the full delegated diff, handling review findings and judging whether a READY change solves the task. Use when the user wants one agent to coordinate while others implement and review, or names CoAgent8 coordinate. Not for trivial edits.
---

# CoAgent8 coordinate

You coordinate and stay answerable for every change; spend your effort on
the spec, verification and judgement rather than typing every edit yourself.
This skill grants no permission: commit, push, merge and publication stay with
the user's authority.

1. **Roles.**
   - **Coordinator** (your session): picks the task, writes the spec,
     delegates, checks the full diff, runs checks, and commits or opens PRs
     only within the user's authority.
   - **Implementer** (`delegate`): edits code, tests and docs within scope.
     Never commits, pushes or opens PRs.
   - **Reviewer** (`review` in a separate session that did not write the
     change; `consult` on the plan of a non-trivial change before coding).
2. **Backend choices.** The user chooses which backend implements and which
   reviews (for example in `~/.coagent8/config.json` or the project's rules);
   leave `backend` and `model` unset unless the user or project rules name one.
   For critical areas (security, money, data, release), keep an independent
   implementer, get an extra review, and check the diff yourself with extra
   care for invariants.
3. **Self-contained task spec.** The implementer has not seen this conversation.
   Include in `task`:
   - the task and quoted acceptance criteria;
   - the `scope` paths it may change and what is out of scope, telling it to
     stop and report if the task needs more;
   - the pattern and project rules to follow (name files and symbols instead of
     pasting them);
   - the exact check commands;
   - what to return: changed paths, assumptions, and `PASS`, `FAIL` or
     `NOT_RUN` (with reason) per check.
4. **Check the diff.** Read the whole diff and the changed/untracked file list
   against `scope` and the server's "Observed by CoAgent8" block; the
   implementer's summary is an index, not proof. Run the proof checks yourself
   when the server loop did not run them.
5. **Review and fix rounds.** Run `review` in an independent session with the
   acceptance criteria and observed check results in `instructions`. Send
   confirmed findings back to the implementer's `session_handle`, quoting
   severity and location, then review again with the review's `session_handle`.
   After two failed attempts on the same task, narrow the task or do it
   yourself.
6. **Judge READY yourself.** A `Verdict: READY` review never merges or accepts a
   change alone. Before accepting, verify yourself that it solves the task,
   follows the pattern, is not overbuilt, and its tests prove the acceptance
   criteria.

When a backend hits a quota or rate limit, tell the user immediately instead of
silently switching roles or backends.
