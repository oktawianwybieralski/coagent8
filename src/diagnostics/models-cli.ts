/**
 * `coagent8 models`: the model view of doctor on the command line (`AX-001`). It lists each
 * backend's models with efforts, output prices and approval tags from cached data, as text or
 * as the report's JSON, which the VS Code command Manage Model Approvals reads.
 *
 * @packageDocumentation
 */
import { PROVIDERS, type ProviderId } from '../contracts/index.js';
import { redactDiagnostic, redactDiagnosticData } from '../security/redaction.js';
import { DOCTOR_SUMMARY_MAX_BYTES, formatModelSummary, runModelReport } from './doctor.js';

const USAGE = 'Usage: coagent8 models [--backend codex|claude|agy] [--json]';

/**
 * Runs `coagent8 models` with the arguments after the command name.
 * @param args - CLI argument strings following the models command name.
 * @param out - Standard output stream.
 * @param err - Standard error stream.
 * @param signal - Optional cancellation signal.
 * @returns The process exit code: 0 for success, 2 for invalid arguments, 130 on cancellation.
 */
export async function runModelsCli(
  args: string[],
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  signal?: AbortSignal,
): Promise<number> {
  let json = false;
  let backend: ProviderId | undefined;
  let stopParsing = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (stopParsing) {
      err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${USAGE}\n`);
      return 2;
    }
    if (arg === '--') {
      stopParsing = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      out.write(`${USAGE}\n`);
      return 0;
    } else if (arg === '--backend') {
      const next = args[++index];
      if (!next || !(PROVIDERS as readonly string[]).includes(next)) {
        err.write(`Unknown argument '${redactDiagnostic(next ?? arg, 64)}'. ${USAGE}\n`);
        return 2;
      }
      backend = next as ProviderId;
    } else if (arg.startsWith('--backend=')) {
      const val = arg.slice('--backend='.length);
      if (!(PROVIDERS as readonly string[]).includes(val)) {
        err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${USAGE}\n`);
        return 2;
      }
      backend = val as ProviderId;
    } else {
      err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${USAGE}\n`);
      return 2;
    }
  }

  const ac = new AbortController();
  const onSigInt = () => {
    ac.abort();
    process.exitCode = 130;
  };
  const effectiveSignal = signal ?? ac.signal;
  if (!signal) {
    process.once('SIGINT', onSigInt);
  }

  try {
    const { trace: _trace, ...report } = await runModelReport({
      ...(backend ? { backend } : {}),
      signal: effectiveSignal,
    });
    out.write(
      `${json ? JSON.stringify(redactDiagnosticData(report)) : redactDiagnostic(formatModelSummary({ ...report }), DOCTOR_SUMMARY_MAX_BYTES)}\n`,
    );
    return 0;
  } catch (error: unknown) {
    const isAbort =
      effectiveSignal.aborted || (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'ABORTED')));
    if (isAbort) {
      return 130;
    }
    const message = error instanceof Error ? error.message : String(error);
    err.write(`Error: ${redactDiagnostic(message, 256)}\n`);
    return 1;
  } finally {
    if (!signal) {
      process.removeListener('SIGINT', onSigInt);
    }
  }
}
