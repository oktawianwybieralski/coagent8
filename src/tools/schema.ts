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

/** Every reasoning effort a backend accepts; each adapter rejects or ignores the ones its CLI lacks. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const WORKSPACE_PARAMETER = {
  workspace_path: { type: 'string', description: 'Repository path; omit for the client workspace (a fallback is named in the footer).' },
};

export const EXECUTION_PARAMETERS = {
  backend: { type: 'string', enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'],
    description: 'codex: Codex CLI; claude: Claude Code; gemini: Antigravity (agy). auto (default): the configured one, else as smart_quota: most quota left, not your own CLI.' },
  model: { type: 'string',
    description: 'Omit for the default. E.g. codex gpt-5.6-luna, claude haiku, gemini gemini-3.8-flash-low. doctor lists them; an unknown one fails before any call.' },
  reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS],
    description: 'Omit for the default; per-model values in doctor. agy models listed with efforts need one (gemini-3.8-flash: low).' },
  session_handle: { type: 'string', minLength: 1, description: 'Handle from a result footer, to continue that conversation.' },
  timeout_ms: { type: 'integer', minimum: 100, maximum: 1800000 },
  ...WORKSPACE_PARAMETER,
};
