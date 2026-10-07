/**
 * Input parameters shared by the execution tools, defined once.
 *
 * @remarks
 * Descriptions are only as long as the name and enum leave unclear, because
 * clients that load tool definitions upfront send them with every request.
 * Rules needed only at call time (continuation) live here rather than in the
 * server instructions, which every client pays for on every turn. Consent for a
 * top-tier model is not a parameter: the server asks the user (AUD-P1-7).
 *
 * @packageDocumentation
 */

/** Every reasoning effort a backend accepts; each adapter rejects or ignores the ones its CLI lacks. */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const WORKSPACE_PARAMETER = {
  workspace_path: { type: 'string', description: 'Omit to use the client workspace.' },
};

export const EXECUTION_PARAMETERS = {
  backend: { type: 'string', enum: ['auto', 'codex', 'claude', 'gemini', 'smart_quota'] },
  model: { type: 'string' },
  reasoning_effort: { type: 'string', enum: [...REASONING_EFFORTS] },
  session_handle: { type: 'string', minLength: 1, description: 'Continue a previous result.' },
  timeout_ms: { type: 'integer', minimum: 100, maximum: 1800000 },
  ...WORKSPACE_PARAMETER,
};
