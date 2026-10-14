---
name: coagent8-doctor
description: Show which models, reasoning efforts and output prices each CoAgent8 backend accepts, or check backend health (installation, sign-in, quota) through the CoAgent8 doctor tool. Use when the user asks which model CoAgent8 can use, gives a price limit, asks why a backend fails, or wants CoAgent8 status.
---

# CoAgent8 doctor

1. For models call `doctor` with `scope: models` (the default). It reads cached
   catalogs and lists, per backend, models, reasoning efforts, output prices,
   the day the price list added each model (not the vendor's release date),
   price freshness and each model's approval tag: `ask: <rule>`, `deny` or
   `allow`. Pass
   `backend` (`codex`, `claude` or `agy`) to narrow it and `detail: full` for the
   same report as JSON.
2. For problems call `doctor` with `scope: health`. It checks installation,
   sign-in and quota and takes longer than the models view.
3. To apply a user's price limit or range (e.g. "X-Y" means `output_price_below: Y`),
   pass `output_price_below` to consult or review and leave `model` unset; the
   server, not the agent, picks the model (the qualifying default or the most
   recently released qualifying model). Do not pick a model from the list to
   work around it.
4. A model tagged `ask` runs only after the user approves it in the form the
   server shows; tell the user its price and that the form will follow before
   you call it. You cannot approve it. A model tagged `deny` never runs: the user
   denied it, so do not call it. `allow` is the user's standing approval.

Do not edit CoAgent8 or client configuration files to change defaults or
approval: the running server may read a different configuration file than the
default path. For CLI installation, sign-in, registration or skill problems
point the user to the VS Code commands **CoAgent8: Manage Coding CLIs** and
**CoAgent8: Manage Skills**, or to `npx -y coagent8@next status`, `repair` and
`skills` (`coagent8 ...` when installed globally).
