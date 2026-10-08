import { formatDoctorSummary, runDoctor } from '../diagnostics/doctor.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { redactDiagnostic } from '../redaction.js';
import type { ProviderId } from '../conversation.js';

export const doctorToolDefinition = {
  name: CANONICAL_TOOL_NAMES.DOCTOR,
  description: 'Backends: install, sign-in, quota, and the models and reasoning efforts each accepts.',
  inputSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', enum: ['codex', 'claude', 'agy'] },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'Default summary; full to diagnose a failure.' },
      quota: { type: 'boolean', description: 'false skips the slower quota reads.' },
    },
  },
};

/** Redacts every string of a JSON value; the structure stays valid because no text is cut across fields. */
function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnostic(value, 2048);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactStrings(entry)]));
  return value;
}

/** Summary text by default; `detail: "full"` returns the report as compact JSON and structured content. */
export async function handleDoctor(args: { backend?: string; detail?: string; quota?: boolean } = {}) {
  const report = await runDoctor({ backend: args.backend as ProviderId | undefined, quota: args.quota });
  if (args.detail !== 'full') {
    return { content: [{ type: 'text', text: redactDiagnostic(formatDoctorSummary(report), 4096) }] };
  }
  const structuredContent = redactStrings(report) as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}
