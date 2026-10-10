---
name: coagent8-doctor
description: Show which models, reasoning efforts and output prices each CoAgent8 backend accepts, or check backend health (installation, sign-in, quota) through the CoAgent8 doctor tool. Use when the user asks which model CoAgent8 can use, gives a price limit, asks why a backend fails, or wants CoAgent8 status.
---

# CoAgent8 doctor

1. For models call `doctor` with `scope: models` (the default). It reads cached
   catalogs and lists, per backend, models, reasoning efforts, output prices,
   price freshness and whether a model needs the user's approval. Pass
   `backend` (`codex`, `claude` or `agy`) to narrow it and `detail: full` for the
   same report as JSON.
2. For problems call `doctor` with `scope: health`. It checks installation,
   sign-in and quota and takes longer than the models view.
3. To apply a user's price limit, pass `output_price_below` to consult or
   review and leave `model` unset; the server picks a model whose verified price
   is below the limit. Do not pick a model from the list to work around it.
4. A model marked as needing approval runs only after the user approves it in
   the form the server shows. You cannot approve it.

Do not edit CoAgent8 or client configuration files to change defaults or
approval: the running server may read a different configuration file than the
default path. For installation or registration problems point the user to
`coagent8 status` and `coagent8 repair`, or the VS Code command CoAgent8: Set Up
Coding CLIs.
