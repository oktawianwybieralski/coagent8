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
   one. For a user's price limit or range (e.g. "X-Y" means `output_price_below: Y`),
   pass `output_price_below` (USD per million output tokens, strict) and leave
   `model` unset; the server picks the qualifying default or the most recently
   released qualifying model. `coagent8-doctor` lists models, prices and the day
   the price list added each model.
4. For a follow-up on the same topic pass the `session_handle` from the result
   footer. A call without it starts a fresh agent that rereads everything.
5. Before calling a model that `coagent8-doctor` tags `ask` (expensive,
   unpriced or on the user's ask list), tell the user its price and that the
   server will show an approval form, and let them choose it or a cheaper model.
   Never call a model tagged `deny`: the user denied it. Their answer in chat is
   not approval: only the form is. Never approve on the user's behalf, never
   change approval settings and never switch models silently to avoid the
   question. If the form closes without an answer, relay the refusal's ways out
   to the user. On a price-limit refusal, report the reason.

The answer is another model's opinion. Verify its claims against the code
before acting, and tell the user where you disagree and why. The consulted agent
runs read-only: it cannot edit files or run commands for you.
