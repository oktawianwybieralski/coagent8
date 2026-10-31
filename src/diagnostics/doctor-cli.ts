/**
 * `coagent8 doctor`: runs diagnostics on the command line (`CLI-FIRST-001e`).
 * Default scope is `models` (cached catalog view); scope `health` verifies CLI discovery,
 * authentication status, and quota headroom. Creates no execution sessions, preserves diagnostic
 * redaction, and exits cleanly on SIGINT (exit code 130).
 *
 * @packageDocumentation
 */
import { PROVIDERS, type ProviderId } from '../contracts/index.js';
import { redactDiagnostic, redactDiagnosticData } from '../security/redaction.js';
import { DOCTOR_SUMMARY_MAX_BYTES, formatDoctorSummary, formatModelSummary, runDoctor, runModelReport } from './doctor.js';

const USAGE = 'Usage: coagent8 doctor [--scope models|health] [--backend codex|claude|agy] [--json]';

const VALID_SCOPES = ['models', 'health'] as const;
type DoctorScope = (typeof VALID_SCOPES)[number];

/**
 * Runs `coagent8 doctor` with the arguments after the command name.
 * @param args - CLI argument strings following the doctor command name.
 * @param out - Standard output stream.
 * @param err - Standard error stream.
 * @param signal - Optional cancellation signal.
 * @returns The process exit code: 0 for success, 2 for invalid arguments, 130 on cancellation.
 */
export async function runDoctorCli(
  args: string[],
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  signal?: AbortSignal,
): Promise<number> {
  let json = false;
  let scope: DoctorScope = 'models';
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
    } else if (arg === '--scope') {
      const next = args[++index];
      if (!next || !(VALID_SCOPES as readonly string[]).includes(next)) {
        err.write(`Unknown argument '${redactDiagnostic(next ?? arg, 64)}'. ${USAGE}\n`);
        return 2;
      }
      scope = next as DoctorScope;
    } else if (arg.startsWith('--scope=')) {
      const val = arg.slice('--scope='.length);
      if (!(VALID_SCOPES as readonly string[]).includes(val)) {
        err.write(`Unknown argument '${redactDiagnostic(arg, 64)}'. ${USAGE}\n`);
        return 2;
      }
      scope = val as DoctorScope;
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
    if (scope === 'health') {
      const { trace: _trace, ...report } = await runDoctor({
        ...(backend ? { backend } : {}),
        signal: effectiveSignal,
      });
      out.write(
        `${json ? JSON.stringify(redactDiagnosticData(report)) : redactDiagnostic(formatDoctorSummary(report), DOCTOR_SUMMARY_MAX_BYTES)}\n`,
      );
    } else {
      const { trace: _trace, ...report } = await runModelReport({
        ...(backend ? { backend } : {}),
        signal: effectiveSignal,
      });
      out.write(
        `${json ? JSON.stringify(redactDiagnosticData(report)) : redactDiagnostic(formatModelSummary({ ...report }), DOCTOR_SUMMARY_MAX_BYTES)}\n`,
      );
    }
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
