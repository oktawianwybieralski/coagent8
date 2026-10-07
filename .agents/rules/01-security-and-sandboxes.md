# P0: Security & Read-Only Governance (`01-security-and-sandboxes.md`)

> **Priority Level: P0 (Critical System Invariant)**  
> Violations block execution and must never be bypassed.

---

## 1. Mandatory Read-Only Sandboxing
All multi-agent review, diagnostic, consultation, and codebase analysis operations must strictly enforce read-only execution modes across external CLI backends to ensure repository and host integrity:
* Codex uses `app-server -c sandbox_mode="read-only" -c approval_policy="never"`;
  each thread start/resume must report `readOnly` and `never`. The older exec
  `--sandbox read-only` invocation is not the current adapter protocol.
* `--restricted --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none --strict-mcp-config` with an empty `--mcp-config` on Claude Code CLI (`claude`); each run is rejected unless the CLI reports at startup only these tools, no MCP server and `dontAsk`. `--bare` is not used: it disables subscription authentication.
* Native `--sandbox` read-only isolation on Google Antigravity CLI (`agy`).

Never grant write permissions or file modification capabilities to external CLI agents during diagnostic, review, or analysis tasks.

---

## 2. Model Cost Governance
A model runs without asking only when it is not on `governance.alwaysAsk` and its
approximate output price is known exactly, below `governance.askAbovePrice`
(default 20 USD per million tokens, the backend's default model included) and
below `governance.priceMultiplier` (default 2) times the price of its backend's
default model. Otherwise it runs only after the user approves it:
* a priced model at or above either limit, or on `alwaysAsk`, is asked on every
  turn;
* a model without a price, or matched to a price only approximately, is asked
  until the user approves it with "remember", which adds it to
  `governance.neverAsk`;
* without any price data, every model not on `neverAsk` is asked.
`neverAsk` exempts a model unless it is also on `alwaysAsk`; only the user's
configuration relaxes a limit. Prices are approximate public API prices
(OpenRouter); they decide only whether to ask, never billing or a model's safety.

**Invariant:** Consent comes from the user through MCP elicitation, asked by the
server for the concrete model the backend will run, including its default. A
calling agent cannot grant it. Without an approval the turn fails closed with
`POLICY_DENIED` before session acquisition or a model turn. Metadata-only probes
(version, auth, catalog, model resolution, prices) can start CLIs or read the
price list before consent.
An accepted form must contain an explicit boolean `approve: true`; an omitted
field is not consent.

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
Codex/agy do not yet isolate inherited external MCP tools (`CUR-002`). Their
shell sandbox flags alone cannot establish the required read-only capability
boundary. These gaps block safety acceptance rather than weakening this rule.

**Consent transport:** implemented in `EXEC-001` (AUD-P1-7); the explicit
`approve: true` requirement closed `CUR-003`. The contract is in
[RUNTIME_CONTRACT](../../docs/RUNTIME_CONTRACT.md#model-consent).
