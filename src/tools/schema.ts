/**
 * Input parameters shared by the execution tools, defined once.
 *
 * @remarks
 * Clients that load tool definitions upfront send them with every request, so each
 * description says only what a calling model needs to choose a value on the first
 * attempt: what the value means, an example and where the accepted values are listed
 * (`CONTEXT-001`; the owner's use cases showed models guessing `luna` and an agy model
 * without its effort). Consent for a top-tier model is not a parameter: the server asks
 * the user (AUD-P1-7).
 *
 * @packageDocumentation
 */

/** Bridge schema union; catalog checks or adapter warnings determine per-model/provider support. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const WORKSPACE_PARAMETER = {
  workspace_path: { type: 'string', description: 'Repository path; omit for the client workspace (a fallback is named in the footer).' },
};

export const EXECUTION_PARAMETERS = {
  backend: { type: 'string', enum: ['auto', 'codex', 'claude', 'agy', 'smart_quota'],
    description: 'codex: Codex CLI; claude: Claude Code; agy: Antigravity. auto (default): configured provider, else as smart_quota: prefer another CLI, rank cached quota.' },
  model: { type: 'string',
    description: 'Omit for the default. doctor lists each backend\'s models and default; a listed catalog rejects unknown names, else the CLI decides.' },
  reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS],
    description: 'Omit for the default; per-model values in doctor. A model listed with efforts needs one, or its name with the effort suffix.' },
  session_handle: { type: 'string', minLength: 1, description: 'Handle from a result footer, to continue that conversation.' },
  timeout_ms: { type: 'integer', minimum: 100, maximum: 1800000 },
  ...WORKSPACE_PARAMETER,
};
