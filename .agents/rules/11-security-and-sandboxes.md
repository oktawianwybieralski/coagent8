# P0: Security and execution profiles

CoAgent8 project rule. It adds requirements to the core rules in
[`core/`](core/) (core rule 01 covers secrets and personal data in general) and
never relaxes one. Violations block execution and are never bypassed.

## Product direction and current enforcement

Owner decision (2026-10-08): full coagents may perform implementation and command
execution under task-scoped user policy. Owner decision (2026-11-21, #208): one
runner serves every role (consult, review, delegate) and every turn
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
* **agy** runs `--dangerously-skip-permissions`; it keeps its subagents, which no
  limit of the server sees (#200). On Windows every agy turn, its resume and the
  check before it run with CoAgent8's own agy profile, which must configure no MCP
  server or plugin (#224, see the current enforcement limits); elsewhere it keeps
  the user's.
* **Roles that answer** (consult, review) are told to leave the workspace as they
  found it. A review is bound to its snapshot, which the server checks again after
  the turn; a change blocks READY.
* **Windows.** Every role refuses to run without the job helper, which ends a
  turn's descendants with it
  ([contract](../../docs/ARCHITECTURE.md#windows-per-call-containment-windows-001)).
* The nested-turn refusal stays: a turn cannot call CoAgent8 itself, and every turn's environment replaces `coagent8_CONFIG`, `coagent8_DIR`, and the other CoAgent8 path overrides with one per-process disposable directory under `os.tmpdir()` (created on the first turn and removed on process exit) and strips `coagent8_EXTENSION_PATHS`, while keeping `COAGENT8_NESTED_TURN` and backend profile variables so CoAgent8 code that a command or test inside a turn runs uses those disposable paths instead of the user's CoAgent8 configuration and data; turns still run on the host with the user's other files (#248; outside a turn, tests run through `tests/run.cjs`).

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
raise them. The calling agent coordinates its workers; the delegated coordinator (#164)
was removed (owner decision 2026-11-24, #212).

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
Codex disables and verifies them per thread. agy cannot disable MCP servers or
plugins itself (`--settings` cannot, agy 1.5.18), so CoAgent8 gives it another
profile (`CUR-002`, owner decision 2026-11-27, #224):

* **Windows.** Turns, their recovery, resume and the profile check that precedes
  them (`agy mcp list`, `agy plugin list`) get `USERPROFILE` set to
  `<data directory>/agy-profile`; agy 1.5.18 finds its configuration there, not
  through `HOME`. Only the turn path creates the profile, right before that check.
  Calls that load no turn tools keep the user's own environment: setup's version,
  help and sign-in checks (`AGY_CLI_CDE_AUTH_ACTION=check`), the probe's
  `--version`, `agy models` (catalog) and `/usage` (quota). Reads by setup status
  or doctor never create the profile. The profile lives in the CoAgent8 data
  directory and has its permissions, like CoAgent8's sessions there (on Windows
  `mode` sets no ACL).
  Before every agy launch of a turn (its automatic recovery turn after an empty
  denial included), CoAgent8 runs `agy mcp list` and `agy plugin list --json`
  there, in the turn's directory (so workspace-scoped agy configuration counts),
  and also reads the profile's plugin directory; a configured MCP server or plugin,
  disabled ones included (a turn could enable either), refuses the turn with
  `POLICY_DENIED` naming them, and so does a check that cannot run, fails, times
  out or prints output CoAgent8 does not recognize. Nothing is cached: commands of
  a turn can add a server or plugin to the profile (`agy mcp add`), and the next
  turn is refused; a profile directory that cannot be created refuses the turn
  too. Doctor runs the same check from its own directory and reports the profile
  as verified, refusing or unverified as checked from there; every turn checks
  again in its own directory. While no turn has created the profile, doctor
  reports it as not created yet (the first turn creates and verifies it) and
  starts no agy against it. agy's built-in skills stay, and so does the `swarm` entry
  agy itself writes into the profile's `config.json` plugins section; a listed
  plugin or a plugin directory named `swarm` is refused like any other. The
  sign-in carries over (Windows Credential Manager), and the user's own agy
  `settings.json` does not apply to CoAgent8 turns. Commands run inside an agy
  turn see the profile as `USERPROFILE`, so `os.homedir()` in Node and what is
  found through it (`~/.npmrc`, `~/.ssh` for tools that read `USERPROFILE`) differ
  from the user's. git and bash keep using `HOME` only where `HOME` is set; without
  it Git for Windows falls back to `HOMEDRIVE`/`HOMEPATH` or `USERPROFILE`, which
  is then the profile.
  A conversation started in the user's own profile before #224 cannot be resumed
  there: its continuation is refused with `SESSION_INVALID` and a request to start
  a new session, never resumed without its context. CoAgent8 marks each
  conversation agy starts in the profile.
* **macOS and Linux.** Unchanged for now: agy's lookup there is unverified and
  changing `HOME` would also move git and the shell. Turns offer the user's agy
  MCP servers and plugins, doctor names them, and agy turns there must not be
  described as isolated from them. Owner decision (2026-10-08): a documented
  limitation of a third-party CLI.

Since #211 agy turns run on the host with `--dangerously-skip-permissions`;
CoAgent8 refuses turns from a CoAgent8 started inside a turn
(`COAGENT8_NESTED_TURN`).

**Consent transport:** implemented in `EXEC-001` (AUD-P1-7); the explicit
`approve: true` requirement closed `CUR-003`. The contract is in
[architecture contract](../../docs/ARCHITECTURE.md#model-consent).
