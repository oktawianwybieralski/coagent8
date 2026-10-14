/**
 * `coagent8 issue`: generates a sanitized bug report on the command line (`FEEDBACK-061c3`).
 * Prints the sanitized report and static form link, and opens the default browser
 * only when `--open` is explicitly provided. Never opens automatically.
 *
 * @packageDocumentation
 */
import { spawn } from 'node:child_process';
import { redactDiagnostic } from '../security/redaction.js';
import { runDoctor } from './doctor.js';
import { generateBugReport, GITHUB_BUG_REPORT_TEMPLATE_URL, type BugReportResult } from './issue.js';

const USAGE = 'Usage: coagent8 issue [--open] [--json]';

const MAX_STDERR_CHARS = 512;
const DEFAULT_OBSERVATION_TIMEOUT_MS = 250;

/** Options for openBrowser, allowing dependency injection for hermetic tests. */
export interface OpenBrowserOptions {
  spawnFn?: typeof spawn;
  timeoutMs?: number;
}

/**
 * Sanitizes partial or complete credential formats and authorization tokens
 * in truncated text before passing to redactDiagnostic.
 */
export function sanitizePartialCredentials(text: string): string {
  let sanitized = text.replace(
    /(?<![A-Za-z0-9_])(?:sk-|sk_live_|AIza|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|npm_|hf_|ya29\.|AKIA|ASIA|ABIA|ACCA|xox[baprs]-|eyJ)[a-zA-Z0-9_.-]*/g,
    '***[REDACTED]***'
  );
  sanitized = sanitized.replace(
    /\b(?:ghp|gho|ghu|ghs|github_pat|glpat|npm|hf|sk_live)(?=$|[^a-zA-Z0-9_])/g,
    '***[REDACTED]***'
  );
  sanitized = sanitized.replace(
    /(?<![A-Za-z0-9_])(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]*/gi,
    '***[REDACTED]***'
  );
  return sanitized;
}

/**
 * Opens a URL in the user's default browser across platforms.
 * Observes launch errors and exit codes for a bounded duration,
 * reporting a sanitized warning via the optional warning callback
 * while isolating faults, capping stderr buffering, and cleaning up pipe handles.
 *
 * @param url - Destination web URL.
 * @param onWarning - Callback to receive sanitized launch warnings.
 * @param options - Optional overrides for timeout or spawn function.
 * @returns Promise resolving to true if launched cleanly, false if warning occurred.
 */
export async function openBrowser(
  url: string,
  onWarning?: (warning: string) => void,
  options?: OpenBrowserOptions
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let childStderr: ReturnType<typeof spawn>['stderr'] | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (childStderr && !childStderr.destroyed) {
        childStderr.destroy();
      }
    };

    const finish = (result: boolean) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(result);
      }
    };

    try {
      const spawnFn = options?.spawnFn ?? spawn;
      let child: ReturnType<typeof spawn>;
      if (process.platform === 'win32') {
        child = spawnFn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } else if (process.platform === 'darwin') {
        child = spawnFn('open', [url], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } else {
        child = spawnFn('xdg-open', [url], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
      }

      childStderr = child.stderr;
      let stderrChars = 0;
      let stderrOutput = '';
      let wasTruncated = false;
      child.stderr?.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (stderrChars < MAX_STDERR_CHARS) {
          const remaining = MAX_STDERR_CHARS - stderrChars;
          stderrOutput += text.slice(0, remaining);
          stderrChars += Math.min(text.length, remaining);
          if (text.length > remaining) {
            wasTruncated = true;
          }
        } else {
          wasTruncated = true;
        }
      });

      child.on('error', (err) => {
        onWarning?.(`Warning: failed to launch browser: ${redactDiagnostic(err.message, 128)}`);
        finish(false);
      });

      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          let rawDetail = stderrOutput;
          if (wasTruncated) {
            // If raw stderr was truncated mid-word, drop the partial trailing word
            // to prevent leaking credential fragments or truncated tokens.
            const lastWhitespace = rawDetail.search(/\s\S+$/);
            if (lastWhitespace !== -1) {
              rawDetail = rawDetail.slice(0, lastWhitespace);
            }
          }
          const sanitizedRaw = sanitizePartialCredentials(rawDetail.trim());
          const detail = redactDiagnostic(sanitizedRaw, 128);
          onWarning?.(`Warning: browser opener exited with code ${code}${detail ? `: ${detail}` : ''}`);
          finish(false);
        } else {
          finish(true);
        }
      });

      child.unref();

      const timeoutMs = options?.timeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
      timer = setTimeout(() => {
        finish(true);
      }, timeoutMs);
      timer.unref?.();
    } catch (error: unknown) {
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      onWarning?.(`Warning: failed to launch browser: ${redactDiagnostic(message, 128)}`);
      finish(false);
    }
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
  optionsOrSignal?: AbortSignal | IssueCliOptions
): Promise<number> {
  const options: IssueCliOptions =
    optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : (optionsOrSignal ?? {});

  let open = false;
  let json = false;
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
    if (arg === '--open') {
      open = true;
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
    const report: BugReportResult = generator({ doctorReport });

    if (json) {
      const payload = {
        title: report.title,
        body: report.body,
        issueUrl: report.issueUrl,
        prompt: report.prompt,
        pasteRequired: true,
      };
      out.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      out.write(report.prompt);
    }

    if (open) {
      const browserOpener = options.openBrowser ?? openBrowser;
      try {
        await browserOpener(GITHUB_BUG_REPORT_TEMPLATE_URL, (warning) => {
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
      effectiveSignal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || ('code' in error && error.code === 'ABORTED')));
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
