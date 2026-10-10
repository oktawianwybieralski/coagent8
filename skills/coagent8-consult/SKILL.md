---
name: coagent8-consult
description: Ask another local coding agent (Codex, Claude Code or Antigravity) for a second opinion through the CoAgent8 consult tool. Use when the user wants a second opinion, a check of a design or plan, help with a stubborn bug, or names CoAgent8 consult. Not for reading files, running commands or questions the workspace already answers.
---

# CoAgent8 consult

Text the user typed with this command is the question; otherwise take it from
the conversation.

1. Write a self-contained `proposal`: the question, the relevant code or
   design, constraints and what was already tried. The other agent has not seen
   this conversation. "Is this retry loop safe with concurrent writers?" plus the
   code is good; "thoughts?" is not.
2. Put workspace paths the other agent should read itself in `context_files`;
   only the paths are sent. Set `task_type` to `architecture`, `debug` or
   `implementation` when you want that kind of analysis; omit it for a plain
   question. Put required criteria in `specific_questions`.
3. Leave `backend`, `model` and `reasoning_effort` unset unless the user named
   one. For a user's price limit pass `output_price_below` (USD per million
   output tokens, strict) and leave `model` unset; `coagent8-doctor` lists
   models and prices.
4. For a follow-up on the same topic pass the `session_handle` from the result
   footer. A call without it starts a fresh agent that rereads everything.
5. If the server asks the user to approve an expensive or unpriced model, the
   user answers that form. Never approve on the user's behalf and never switch
   models silently to avoid the question. On a price-limit refusal, report the
   reason.

The answer is another model's opinion. Verify its claims against the code
before acting, and tell the user where you disagree and why. The consulted agent
runs read-only: it cannot edit files or run commands for you.
