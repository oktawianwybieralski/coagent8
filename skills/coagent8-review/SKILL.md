---
name: coagent8-review
description: Independent review of Git changes by another local coding agent through the CoAgent8 review tool. Use when the user asks to review uncommitted or staged changes, a commit, a branch or a range, wants a check before committing or opening a pull request, or names CoAgent8 review.
---

# CoAgent8 review

Text the user typed with this command names the scope or the review focus.

1. Choose `scope`: `uncommitted` (default), `staged`, a commit, a branch or a
   range `a...b`. Check with Git that the scope contains the changes you mean.
2. Put the review focus in `instructions`: the goal of the change, acceptance
   criteria and risky areas, naming files instead of pasting code; the reviewer
   reads the diff from Git. Do not paste earlier review transcripts and do not
   ask the reviewer to answer READY.
3. Leave `backend` and `model` unset unless the user named one; `auto` prefers a
   different CLI than yours. For a user's price limit or range (e.g. "X-Y" means
   `output_price_below: Y`), pass `output_price_below` and leave `model` unset;
   the server picks the qualifying default or the most recently released
   qualifying model. The author of a change cannot supply its own
   independent approval. A model `coagent8-doctor` tags `ask` runs only after
   the user approves the server's form: tell the user before the call. Never
   call a model tagged `deny`.
4. Read the result. The reviewer's `VERDICT:` in the body is its judgement; the
   server's `Verdict: READY` or `Verdict: BLOCKED (reason)` in the footer is the
   gate decision.
5. A read-only reviewer cannot run typecheck or tests; checks it cannot observe
   are reported as not run and can keep the verdict BLOCKED. Run the checks
   yourself and report their commands and results separately. Repeating the same
   review does not change that verdict.
6. Fix the findings you accept, then review again. Pass the `session_handle`
   from the footer so the reviewer compares with its previous round. Any code
   change invalidates the previous verdict; do not repeat a review of unchanged
   code that completed with full coverage: the server then starts no turn and
   returns the earlier verdict (an incomplete or failed review can be retried).
   After two further rounds without progress, stop and ask the user.

Report the server verdict, each finding with its location and your disposition
(fixed, rejected with the reason, or deferred), and the checks you ran.
