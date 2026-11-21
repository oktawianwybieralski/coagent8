# P0: Security and execution profiles

CoAgent8 project rule. It adds requirements to the core rules in
[`core/`](core/) (core rule 01 covers secrets and personal data in general) and
never relaxes one. Violations block execution and are never bypassed.

## Product direction and current enforcement

Owner decision (2026-10-08): full coagents may perform implementation and command
execution under task-scoped user policy. Owner decision (2026-11-21, #208): one
runner serves every role (consult, review, delegate, coordinator) and every turn
runs on the host, without a per-backend sandbox. Isolation comes later from the
environment, containers or microVMs (#215); a user who accepts it runs without
one. Skills and delegated agents cannot grant themselves permissions or model
consent.

## 1. Host execution (#211)

Every turn runs on the user's computer with the user's account rights: it can read
and change files, run commands and use the network. This replaces the read-only
and workspace-write profiles of earlier versions (owner decision 2026-11-21).

* **Consent.** No model turn starts until the user accepted host execution:
  `"hostExecution": "accepted"` in the configuration, or a one-time MCP form that
  records it. A client that cannot show the form gets a refusal that says how to
  give it. A calling agent, skill or worker cannot give it. The environment of
  the server process may give it too (`COAGENT8_HOST_EXECUTION=accepted`): whoever
  starts the server is the user or acts for them, as for a headless setup, and the
  test suite sets it in its hermetic environment. A turn's own environment cannot
  reach the server that started it.
* **Codex** runs `app-server -c sandbox_mode="danger-full-access" -c
  approval_policy="never"`; each thread start or resume must report
  `dangerFullAccess` and `never`. Its tool features (connectors, plugins, browser
  and computer use, hooks, subagents) stay off, and every configured MCP server is
  disabled and must be reported `disabled` before the turn starts. On Windows
  commands run without the user's PowerShell profile (`allow_login_shell=false`).
* **Claude Code** runs `--restricted --tools
  Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch --permission-mode dontAsk
  --permission-prompts none --strict-mcp-config` with an empty `--mcp-config`,
  hooks off and an allow rule for each tool; each run is rejected unless the CLI
  reports at startup only these tools, no MCP server and `dontAsk`.
* **agy** runs `--dangerously-skip-permissions`; it keeps its own MCP servers and
  subagents, which no limit of the server sees, so coordination stays refused on
  agy (#200).
* **Roles that answer** (consult, review) are told to leave the workspace as they
  found it. A review is bound to its snapshot, which the server checks again after
  the turn; a change blocks READY.
* **Windows.** Every role refuses to run without the job helper, which ends a
  turn's descendants with it
  ([contract](../../docs/ARCHITECTURE.md#windows-per-call-containment-windows-001)).
* The nested-turn refusal stays: a turn cannot call CoAgent8 itself.

### Delegate (DELEGATE-001w)

Only the `delegate` tool changes files on purpose. Its session belongs to the
delegate group at creation: `consult` and `review` cannot continue it, nor can
`delegate` continue a session of another role (#210).

Writers of a Git work tree hold disjoint paths, recorded in its Git directory so
every client's server process sees them; no `scope` or `loop: true` holds the whole
tree, and an overlapping start is refused (0.8.0 plan, owner decision 2026-11-02).
A path claim schedules writers and is no sandbox: nothing limits a turn's writes
to its scope. The server reports the Git changes it observed before and after the
turn, whoever may have made them, and never commits, resets or cleans up. Root
limits come from the user's `rootLimits`; a calling agent, skill or worker cannot
raise them. A coordinator (`delegate` with `coordinate: true`, #164) runs with no
MCP server added; neither it nor its workers run on agy. Its answer is untrusted
data that the server validates; root, parent, session and role come from the
server's records, and no one can approve a model or a check for its workers.

### Checks the server runs (DELEGATE-001f2, REVIEW-003)

Owner decisions 2026-11-02 and 2026-11-03: the server itself may run `checks`, after a delegated
worker (`delegate` with `loop: true`) and before a review (`review` with `checks`). They run with
the user's account, outside any sandbox, and execute code a worker may have changed or that is
under review. A reviewer may run commands too; a check the server ran is evidence whatever the reviewer reports.
* A check runs only if it is an exact entry of the user's `allowedChecks`, or the user approved it
  on an MCP form for that call. A calling agent, skill or worker cannot approve one, and a form
  the client declines or closes is reported as the client's answer, never as the user's.
* A check is one command with arguments, parsed without a shell; shell operators are refused.
  This limits its syntax, not what it can do.
* Its run is bounded in time (15 minutes, and the task's or call's budget) and in output: only the
  redacted end of its output is kept (8 KiB), each line redacted before the cut, private keys
  across lines.
* Its result is evidence the server observed: a check that does not pass blocks the review or the
  loop whatever a model reports. Before a review, the work tree is checked after every check, and
  a check that changed the reviewed state refuses the review before any turn.

---

## 2. Model Cost Governance
The user's own rules in `governance.models` decide first, in the allow/ask/deny
convention (owner decision 2026-10-11); `deny` wins over `ask`, `ask` over
`allow`, and an id also covers its effort variants:
* `deny`: the model never runs; the call fails with `POLICY_DENIED` and that
  reason, and a price limit never chooses it;
* `ask`: the model is asked for on every turn whatever it costs, and the request
  states its price;
* `allow`: the user's standing approval; the model runs without asking.

Any other model runs without asking only when its approximate output price is
known exactly, below `governance.askAbovePrice` (default 20 USD per million
tokens, the backend's default model included) and below
`governance.priceMultiplier` (default 2) times the price of its backend's
default model. Otherwise it runs only after the user approves it:
* a priced model at or above either limit is asked on every turn;
* a model without a price, or matched to a price only approximately, is asked
  until the user approves it with "remember", which adds it to
  `governance.models.allow`;
* without any price data, every model not on `models.allow` is asked.

Only the user's configuration relaxes a limit or edits these lists; a calling
agent never changes them. Prices are approximate public API prices
(OpenRouter); they decide only whether to ask, never billing or a model's safety.

**Invariant:** Consent comes from the user through MCP elicitation, asked by the
server for the concrete model the backend will run, including its default. A
calling agent cannot grant it. Without an approval the turn fails closed with
`POLICY_DENIED` before session acquisition or a model turn. Metadata-only probes
(version, auth, catalog, model resolution, prices) can start CLIs or read the
price list before consent.
An accepted form must contain an explicit boolean `approve: true`; an omitted
field is not consent. A form the client declines or closes, which clients do
without showing it (Claude Code 2.1.317 declines, Codex 0.164 cancels; #135,
#140), is reported as the client's answer with the user's ways to approve, never
as the user's refusal. The same applies to the approval of checks (section 1).

---

## 3. Automated Secret Redaction
All execution results, streaming activity lines, bug reports, and diagnostic logs must pass through automated secret redaction before public emission:
* Recognized API keys (`sk-...`, Bearer tokens, AWS keys, Slack tokens).
* Basic authentication credentials, passwords, and private keys.
* User home directory absolute paths (redacted to `~`).
* Redaction strictly precedes buffer truncation to avoid exposing credential prefixes.

**Output integrity:** Redaction must not change the meaning of public model
answers. In answers and stored assistant messages, replace only recognized
credential formats (for example `sk-...`, `sk_live_...`, `ghp_...`, `gho_...`, `ghu_...`,
`ghs_...`, `github_pat_...`, `glpat-...`, `ya29....`, `npm_...`, `hf_...`, bare JWT,
AWS key IDs, PEM private keys, `Bearer` tokens). Keyword-based rules
(`token=`, `password:`, `auth=`) and home path redaction apply to diagnostics,
stderr, error messages, doctor output and issue reports. Rewriting ordinary code
such as `const token = getToken();` is a defect, not a privacy feature.
This rule is implemented in `REDACTION-002` (AUD-P0-2, AUD-P2-13).

**Current enforcement limits:** Claude disables hooks and inherited MCP servers;
Codex disables and verifies them per thread. agy cannot isolate inherited
external MCP tools or plugins (`CUR-002`). Owner decision (2026-10-08): this
is a documented limitation of a third-party CLI. Since #211 agy turns run on the
host with `--dangerously-skip-permissions`; CoAgent8 refuses turns from a CoAgent8 started inside a turn
(`COAGENT8_NESTED_TURN`), names agy's inherited servers and plugins in doctor,
and must not describe agy turns as isolated from them.

**Consent transport:** implemented in `EXEC-001` (AUD-P1-7); the explicit
`approve: true` requirement closed `CUR-003`. The contract is in
[architecture contract](../../docs/ARCHITECTURE.md#model-consent).
