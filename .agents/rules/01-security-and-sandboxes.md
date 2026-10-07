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

## 2. Top-Tier Model Governance
Models classified as top-tier reasoning engines run only after the user approves them:
* `astra` family in OpenAI Codex.
* `claude-3-opus` / `opus` family in Claude Code, also when reached through agy.

**Invariant:** Consent comes from the user through MCP elicitation, asked by the
server for the model the backend will actually run, including its default. A
calling agent cannot grant it. Without an approval the turn fails closed with
`POLICY_DENIED` before session acquisition or a model turn. Metadata-only
version/auth/catalog probes can launch CLIs before consent.
An accepted form must contain an explicit boolean `approve: true`; an omitted
field is not consent. Current missing-field acceptance is a defect (`CUR-003`).

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

**Consent transport:** implemented in `EXEC-001` (AUD-P1-7), with `CUR-003`
reopening fail-closed approval. The contract is in
[RUNTIME_CONTRACT](../../docs/RUNTIME_CONTRACT.md#top-tier-model-consent).
