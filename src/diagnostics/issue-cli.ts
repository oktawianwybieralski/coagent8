/**
 * `coagent8 issue`: opens the bug report form with the sanitized environment filled in.
 * Prints the form link and opens it in the default browser, unless `--no-open` or `--json`
 * is given. It never submits the report.
 *
 * @packageDocumentation
 */
import { spawn } from 'node:child_process';
import { redactDiagnostic } from '../security/redaction.js';
import { runDoctor } from './doctor.js';
import { generateBugReport, type BugReportResult } from './issue.js';

const USAGE = 'Usage: coagent8 issue [--title <text>] [--no-open] [--json] [what happened...]';

/** Bounds how long `--open` waits for the opener to report a launch failure. */
const OBSERVATION_TIMEOUT_MS = 2000;

/** Options for openBrowser, allowing dependency injection for hermetic tests. */
export interface OpenBrowserOptions {
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

/**
 * Opens a URL in the user's default browser across platforms. On Windows the URL goes to the
 * shell's URL handler directly, never through `cmd.exe`, which would split it at `&` and expand `%`.
 * Waits a bounded time for the opener to exit and reports a launch error or a
 * non-zero exit code through the warning callback. The opener's output is ignored.
 *
 * @param url - Destination web URL.
 * @param onWarning - Callback to receive sanitized launch warnings.
 * @param options - Optional overrides for timeout or spawn function.
 * @returns Promise resolving to false if a warning was reported, true otherwise.
 */
export async function openBrowser(url: string, onWarning?: (warning: string) => void, options?: OpenBrowserOptions): Promise<boolean> {
  const spawnFn = options?.spawnFn ?? spawn;
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const launchFailed = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    onWarning?.(`Warning: failed to launch browser: ${redactDiagnostic(message, 128)}`);
  };

  return new Promise<boolean>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      // Not detached: a detached child gets no CREATE_NO_WINDOW and can show a console window.
      child = spawnFn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch (error: unknown) {
      launchFailed(error);
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      // An opener that is still running has launched; leave it behind without holding the CLI.
      child.unref();
      resolve(true);
    }, options?.timeoutMs ?? OBSERVATION_TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timer);
      launchFailed(error);
      resolve(false);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        onWarning?.(`Warning: browser opener exited with code ${code}`);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/** Dependencies for hermetic unit testing of the issue CLI. */
export interface IssueCliOptions {
  openBrowser?: (url: string, onWarning?: (warning: string) => void) => void | boolean | Promise<void | boolean>;
  runDoctorFn?: typeof runDoctor;
  generateReportFn?: typeof generateBugReport;
  signal?: AbortSignal;
}

/**
 * Runs `coagent8 issue` with the given argument list.
 *
 * @param args - CLI arguments after the issue subcommand name.
 * @param out - Standard output stream.
 * @param err - Standard error stream.
 * @param optionsOrSignal - Optional signal or dependency overrides.
 * @returns Exit code (0 for success, 2 for usage error, 130 on cancellation, 1 on fatal error).
 */
export async function runIssueCli(
  args: string[],
  out: NodeJS.WritableStream = process.stdout,
  err: NodeJS.WritableStream = process.stderr,
  optionsOrSignal?: AbortSignal | IssueCliOptions,
): Promise<number> {
  const options: IssueCliOptions = optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : (optionsOrSignal ?? {});

  let open: boolean | undefined;
  let json = false;
  let title: string | undefined;
  const description: string[] = [];
  let stopParsing = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (stopParsing || !arg.startsWith('-')) {
      description.push(arg);
      continue;
    }
    if (arg === '--') {
      stopParsing = true;
      continue;
    }
    if (arg === '--open') {
      open = true;
    } else if (arg === '--no-open') {
      open = false;
    } else if (arg === '--title') {
      if (index + 1 >= args.length) {
        err.write(`--title needs a value. ${USAGE}\n`);
        return 2;
      }
      title = args[++index];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      out.write(`${USAGE}\n`);
      return 0;
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
  const effectiveSignal = options.signal ?? ac.signal;
  if (!options.signal) {
    process.once('SIGINT', onSigInt);
  }

  try {
    if (effectiveSignal.aborted) {
      return 130;
    }

    let doctorReport = null;
    try {
      const doctorFn = options.runDoctorFn ?? runDoctor;
      const result = await doctorFn({ signal: effectiveSignal });
      doctorReport = result;
    } catch {
      // Secondary telemetry failure: proceed without doctor report
    }

    if (effectiveSignal.aborted) {
      return 130;
    }

    const generator = options.generateReportFn ?? generateBugReport;
    const report: BugReportResult = generator({
      title,
      context: description.length > 0 ? description.join(' ') : undefined,
      doctorReport,
    });

    if (json) {
      const payload = {
        title: report.title,
        body: report.body,
        issueUrl: report.issueUrl,
        prompt: report.prompt,
        pasteRequired: report.pasteRequired,
      };
      out.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      out.write(report.prompt);
    }

    if (open ?? !json) {
      const browserOpener = options.openBrowser ?? openBrowser;
      try {
        await browserOpener(report.issueUrl, warning => {
          err.write(`${warning}\n`);
        });
      } catch (openerError: unknown) {
        const message = openerError instanceof Error ? openerError.message : String(openerError);
        err.write(`Warning: failed to launch browser: ${redactDiagnostic(message, 128)}\n`);
      }
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
    if (!options.signal) {
      process.removeListener('SIGINT', onSigInt);
    }
  }
}
