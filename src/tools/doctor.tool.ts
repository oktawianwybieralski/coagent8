import { DOCTOR_SUMMARY_MAX_BYTES, formatDoctorSummary, formatModelSummary, runDoctor, runModelReport } from '../diagnostics/doctor.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';
import { redactDiagnostic } from '../redaction.js';
import type { ProviderId } from '../conversation.js';

export const doctorToolDefinition = {
  name: CANONICAL_TOOL_NAMES.DOCTOR,
  description: 'Models per backend: efforts, output prices, approval need; or backend health.',
  inputSchema: {
    type: 'object',
    properties: {
      backend: { type: 'string', enum: ['codex', 'claude', 'agy'] },
      scope: { type: 'string', enum: ['models', 'health'], description: 'models (default, cached); health: install, sign-in, quota.' },
      // The enum says it: a summary by default, or the same report as JSON.
      detail: { type: 'string', enum: ['summary', 'full'] },
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

/**
 * The model view by default (`scope: "models"`, cached); `scope: "health"` runs the full
 * diagnosis. Summary text by default; `detail: "full"` returns the report as compact JSON and
 * structured content.
 */
export async function handleDoctor(args: { backend?: string; detail?: string; scope?: string } = {}) {
  const backend = args.backend as ProviderId | undefined;
  const report = args.scope === 'health' ? await runDoctor({ backend }) : await runModelReport({ backend });
  if (args.detail !== 'full') {
    const summary = 'scope' in report ? formatModelSummary(report) : formatDoctorSummary(report);
    return { content: [{ type: 'text', text: redactDiagnostic(summary, DOCTOR_SUMMARY_MAX_BYTES) }] };
  }
  const structuredContent = redactStrings(report) as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
}
