---
name: coagent8-loop
description: Carry out a non-trivial change in a loop led by you, with CoAgent8 for plan review and independent code review - requirements, plan, plan review, implementation, your own checks, independent review and fixes. Use when the user asks for a careful or reviewed implementation, a plan review before coding, or names the CoAgent8 loop. Not for trivial edits.
---

# CoAgent8 loop

You lead the loop and make every change. CoAgent8 agents run read-only: they
review, they do not edit. This skill grants no permission. Commit, push, merge,
deploy and publish only with the user's authority.

1. **Size.** For a trivial edit skip the loop and make the change directly.
2. **Recon.** Read the relevant code and the project's documents. List your
   assumptions and where each comes from.
3. **Requirements.** Ask the user only about decisions that change the outcome.
4. **Plan.** Write the objective, scope (files), observable acceptance criteria
   and the commands that prove them. Use the project's existing plan document if
   it has one; do not create plan files the user did not ask for.
5. **Plan review.** Use `coagent8-consult` with `task_type: implementation` or
   `architecture`, the plan as `proposal` and the relevant paths in
   `context_files`. Continue the same `session_handle` for revisions. Give every
   finding a disposition: accepted, rejected with the reason, or deferred. After
   three rounds without agreement, show the open points to the user.
6. **Implement** once the user agrees with the plan.
7. **Verify.** Run the proof commands yourself and record each command, exit
   code and result. Fix failures, at most two rounds, then report what still
   fails.
8. **Independent review.** Use `coagent8-review` without the plan review's
   session, with a scope that covers the change and `instructions` holding the
   acceptance criteria and the checks you ran. Fix accepted findings and review
   again with the review's `session_handle`, at most two more rounds. A code
   change invalidates the previous verdict.
9. **Report** the plan, finding dispositions, the checks you observed, the final
   server `Verdict:` and the remaining risks.

BLOCKED is not approval, and exhausted rounds are reported as they are, never as
success. Leave `backend` and `model` unset unless the user named one or a price
limit.
