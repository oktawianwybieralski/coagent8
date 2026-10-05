# P0: Security & Read-Only Governance (`01-security-and-sandboxes.md`)

> **Priority Level: P0 (Critical System Invariant)**  
> Violations block execution and must never be bypassed.

---

## 1. Mandatory Read-Only Sandboxing
All multi-agent review, diagnostic, consultation, and codebase analysis operations must strictly enforce read-only execution modes across external CLI backends to ensure repository and host integrity:
* `--sandbox read-only` on OpenAI Codex CLI (`codex`).
* `--restricted --tools Read,Glob,Grep --permission-mode dontAsk --permission-prompts none --strict-mcp-config` with an empty `--mcp-config` on Claude Code CLI (`claude`); each run is rejected unless the CLI reports at startup only these tools, no MCP server and `dontAsk`. `--bare` is not used: it disables subscription authentication.
* Native `--sandbox` read-only isolation on Google Antigravity CLI (`agy`).

Never grant write permissions or file modification capabilities to external CLI agents during diagnostic, review, or analysis tasks.

---

## 2. Top-Tier Model Governance
Models classified as top-tier reasoning engines strictly require prior user confirmation via an interactive user prompt (`ask_question`):
* `astra` family in OpenAI Codex.
* `claude-3-opus` / `opus` family in Claude Code.

**Invariant:** Never pass `user_confirmed: true` without explicit, prior user selection. Unconfirmed attempts must fail closed with `POLICY_DENIED`.

---

## 3. Automated Secret Redaction
All execution results, streaming activity lines, bug reports, and diagnostic logs must pass through automated secret redaction before public emission:
* Recognized API keys (`sk-...`, Bearer tokens, AWS keys, Slack tokens).
* Basic authentication credentials, passwords, and private keys.
* User home directory absolute paths (redacted to `~`).
* Redaction strictly precedes buffer truncation to avoid exposing credential prefixes.

**Output integrity:** Redaction must not change the meaning of public model
answers. In answers and stored assistant messages, replace only recognized
credential formats (for example `sk-…`, `ghp_…`, AWS key IDs, PEM private keys,
`Bearer` tokens). Keyword-based rules (`token=`, `password:`, `auth=`) and home
path redaction apply to diagnostics, stderr, error messages, doctor output and
issue reports. Rewriting ordinary code such as `const token = getToken();` is a
defect, not a privacy feature. The current implementation violates this rule;
remediation is `REDACTION-002` (AUD-P0-2) in the [roadmap](../../docs/ROADMAP.md#audit-remediation-index).

**Consent enforcement:** `user_confirmed` is an assertion by the calling agent;
the server cannot verify it. Server-side confirmation through MCP elicitation is
tracked in `EXEC-001` (AUD-P1-7). Until then, agents must follow the invariant
above.
