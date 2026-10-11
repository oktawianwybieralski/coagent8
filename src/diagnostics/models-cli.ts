/**
 * `coagent8 models`: the model view of doctor on the command line (`AX-001`). It lists each
 * backend's models with efforts, output prices and approval tags from cached data, as text or
 * as the report's JSON, which the VS Code command Manage Model Approvals reads.
 *
 * @packageDocumentation
 */
import { PROVIDERS, type ProviderId } from '../contracts/index.js';
import { redactDiagnostic } from '../security/redaction.js';
import { formatModelSummary, runModelReport } from './doctor.js';

const USAGE = 'Usage: coagent8 models [--backend codex|claude|agy] [--json]';

/**
 * Runs `coagent8 models` with the arguments after the command name.
 * @returns The process exit code: 0, or 2 for invalid arguments.
 */
export async function runModelsCli(args: string[], out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr): Promise<number> {
  let json = false;
  let backend: ProviderId | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') json = true;
    else if (arg === '--backend' && (PROVIDERS as readonly string[]).includes(args[index + 1] ?? '')) backend = args[++index] as ProviderId;
    else if (arg === '--help' || arg === '-h') { out.write(`${USAGE}\n`); return 0; }
    else { err.write(`Unknown argument '${redactDiagnostic(arg ?? '', 64)}'. ${USAGE}\n`); return 2; }
  }
  const { trace: _trace, ...report } = await runModelReport(backend ? { backend } : {});
  out.write(`${json ? JSON.stringify(report) : formatModelSummary({ ...report })}\n`);
  return 0;
}
