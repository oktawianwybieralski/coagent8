/**
 * Input parameters shared by the execution tools, defined once.
 *
 * @remarks
 * Clients that load tool definitions upfront send them with every request, so each
 * description says only what a calling model needs to choose a value on the first
 * attempt: what the value means, an example and where the accepted values are listed
 * (`CONTEXT-001`; the owner's use cases showed models guessing `luna` and an agy model
 * without its effort). Consent for a top-tier model is not a parameter: the server asks
 * the user (AUD-P1-7). A user's price limit is a parameter (`AX-002`): the user's
 * constraint, not consent, and a reason to select a model that descriptions otherwise
 * leave unset (`AX-006`). Model-visible definitions stay within 5,800 bytes (owner
 * decision of 2026-10-10 for actionable issue telemetry instructions).
 *
 * @packageDocumentation
 */

/** Bridge schema union; catalog checks or adapter warnings determine per-model/provider support. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const WORKSPACE_PARAMETER = {
  workspace_path: { type: 'string', description: 'Repository path; omit for client workspace (fallback in footer).' },
};

export const EXECUTION_PARAMETERS = {
  backend: { type: 'string', enum: ['auto', 'codex', 'claude', 'agy', 'smart_quota'],
    description: 'codex: Codex CLI; claude: Claude Code; agy: Antigravity. auto (default): configured provider, else another CLI than yours, most cached quota.' },
  model: { type: 'string',
    description: 'Omit unless the user names a model or price limit. doctor lists models, efforts and prices; a catalog rejects unknown names.' },
  reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS],
    description: 'Omit for the default; doctor lists per-model values. Required where listed, or as a model name suffix.' },
  output_price_below: { type: 'number', minimum: 0,
    description: 'User limit, USD per million output tokens, strict (5 excludes 5). Only verified prices qualify; auto picks a model.' },
  session_handle: { type: 'string', minLength: 1, description: 'Handle from result footer, to continue conversation.' },
  timeout_ms: {
    type: 'integer',
    minimum: 100,
    maximum: 1800000,
    description: 'Total monotonic call budget in ms for full lifecycle (Git, prep, consent, CLI turn, teardown).',
  },
  ...WORKSPACE_PARAMETER,
};

