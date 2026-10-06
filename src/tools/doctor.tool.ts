import { runDoctor } from '../diagnostics/doctor.js';
import { CANONICAL_TOOL_NAMES } from '../constants/index.js';
import { redactDiagnostic } from '../redaction.js';

export const doctorToolDefinition = {
  name: CANONICAL_TOOL_NAMES.DOCTOR,
  description:
    'Health diagnostics, auth evidence, and CLI version probes across OpenAI Codex, Claude Code, and Gemini CLI.',
  inputSchema: {
    type: 'object',
    properties: {
      repair: {
        type: 'boolean',
        description: 'Attempt automatic repair or installation hints.',
      },
      workspace_path: {
        type: 'string',
        description: 'Optional workspace path.',
      },
    },
  },
};

export async function handleDoctor() {
  const report = await runDoctor();
  return {
    content: [{ type: 'text', text: redactDiagnostic(JSON.stringify(report, null, 2), 16384) }],
  };
}
