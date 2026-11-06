# P0: Security and execution profiles

CoAgent8 project rule. It adds requirements to the core rules in
[`core/`](core/) (core rule 01 covers secrets and personal data in general) and
never relaxes one. Violations block execution and are never bypassed.

## Product direction and current enforcement

Owner decision (2026-10-08): full coagents may perform implementation and command
execution under task-scoped user policy. The migration is specified by
the [coagent direction](../../docs/ROADMAP.md#full-coagent-direction), issues
[#160](https://github.com/oktawianwybieralski/coagent8/issues/160) (profiles) and [#165](https://github.com/oktawianwybieralski/coagent8/issues/165) (compatibility).
This replaces the consultation-only product boundary and proposed blanket
sandbox opt-out. Current profiles below remain enforced until each replacement
is implemented and verified. Planning a capability does not make it available.
Consultation, planning inspection and independent review retain read-only access;
mutating tasks need a distinct verified profile. Skills and delegated agents
cannot grant themselves permissions or model consent.

## 1. Mandatory Read-Only Sandboxing
All multi-agent review, diagnostic, consultation, and codebase analysis operations must strictly enforce read-only execution modes across external CLI backends to ensure repository and host integrity:
* Codex uses `app-server -c sandbox_mode="read-only" -c approval_policy="never"`
  with its tool features (connectors, plugins, browser and computer use, hooks,
  subagents) off; each thread start/resume must report `readOnly` and `never`,
  disables every configured MCP server, and must report every MCP server
  `disabled` before the turn starts. On Windows it also passes
  `windows.sandbox="unelevated"` (a restricted token of the user's own account)
  and `allow_login_shell=false`, and removes the app execution alias directory
  from the server's `PATH` (owner decision 2026-10-21, `CUR-014`). The older exec `--sandbox read-only`
  invocation is not the current adapter protocol.
* `--restricted --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none --strict-mcp-config` with an empty `--mcp-config` on Claude Code CLI (`claude`); each run is rejected unless the CLI reports at startup only these tools, no MCP server and `dontAsk`. `--bare` is not used: it disables subscription authentication.
* Native `--sandbox` read-only isolation on Google Antigravity CLI (`agy`).

Never grant write permissions or file modification capabilities to external CLI agents during diagnostic, review, or analysis tasks.

### Delegate write profile (DELEGATE-001w)

Owner decision 2026-10-21: only the `delegate` tool runs the `workspace-write`
profile, chosen by the server and never by a call argument. Its session is bound
to that profile at creation; `consult` and `review` cannot continue it, nor can
`delegate` continue a read-only session. Approvals, tool features and inherited
MCP servers stay disabled and verified as above, and the nested-turn refusal stays.
* Codex: `sandbox_mode="workspace-write"` with network access, extra writable
  roots and temporary write roots off; each thread start/resume must report
  `workspaceWrite`, `never`, no network, both temporary roots excluded, its own
  `cwd` and no writable root outside it.
* Claude Code: tools `Read,Glob,Grep,Edit,Write,Bash` with `dontAsk` and allow
  rules `Edit(./**)`, `Write(./**)` and `Bash`; `system/init` must report only
  these tools. `Bash` is not path-limited (documented limitation).
* agy: no `--sandbox`, `--mode accept-edits` (headless agy approves file edits and
  denies every command) and no enforced write path limit (documented
  limitation). A denial ends the headless turn; the server sends at most one
  recovery turn that keeps the writer inside the workspace (#92).

Writers of a Git work tree hold disjoint paths, recorded in its Git directory so
every client's server process sees them; no `scope` or `loop: true` holds the whole
tree, and an overlapping start is refused (0.8.0 plan, owner decision 2026-11-02).
A path claim schedules writers and is no sandbox: the limits above are the only
containment, and Claude's `Edit` and `Write` rules narrow to the scope unless an entry
has a pattern character. The server
reports the Git changes it observed before and after the turn, whoever
may have made them, and never commits, resets or cleans up. Root limits come from the
user's `rootLimits`; a calling agent, skill or worker cannot raise them. A coordinator
(`delegate` with `coordinate: true`, #164) runs the read-only profile with no MCP server added, and never on agy,
whose subagents no limit sees. Its
answer is untrusted data that the server validates; root, parent, session and profile
come from the server's records, and no one can approve a model or a check for its workers. On Windows `delegate` refuses to run without the job helper,
which ends a cancelled worker's descendants with it
([contract](../../docs/ARCHITECTURE.md#windows-per-call-containment-windows-001)).

### Checks the server runs (DELEGATE-001f2, REVIEW-003)

Owner decisions 2026-11-02 and 2026-11-03: the server itself may run `checks`, after a delegated
worker (`delegate` with `loop: true`) and before a review (`review` with `checks`). They run with
the user's account, outside any sandbox, and execute code a worker may have changed or that is
under review. The backends' profiles above stay as they are: the reviewer remains read-only.
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
external MCP tools or plugins (`CUR-002`); its shell sandbox flag alone does not
establish the read-only capability boundary. Owner decision (2026-10-08): this
is a documented limitation of a third-party CLI. CoAgent8 runs agy only with
`--sandbox`, refuses turns from a CoAgent8 started inside a turn
(`COAGENT8_NESTED_TURN`), names agy's inherited servers and plugins in doctor,
and must not describe agy turns as isolated from them.

**Consent transport:** implemented in `EXEC-001` (AUD-P1-7); the explicit
`approve: true` requirement closed `CUR-003`. The contract is in
[architecture contract](../../docs/ARCHITECTURE.md#model-consent).
