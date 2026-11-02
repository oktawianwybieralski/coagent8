/**
 * Commands the server runs after a delegated change (`DELEGATE-001f2`).
 *
 * @remarks
 * Owner decision 2026-11-02: a check runs with the user's account and outside any sandbox, and it
 * executes code the worker may have changed. So it runs only when the user allowed it: by an exact
 * entry in `allowedChecks`, or through a form that says so. A calling agent cannot approve one.
 * A check is an argument list without a shell, which limits its syntax, not what it can do.
 *
 * @packageDocumentation
 */
import { ToolError } from '../contracts/error.js';
import type { CheckResult } from '../contracts/execution.js';
import { redactDiagnostic } from '../security/redaction.js';
import { runCommand } from './process.js';

/** Longest run of one check. */
const CHECK_TIMEOUT_MS = 15 * 60 * 1000;
/** Output kept from the end of a check, which is where a failure usually shows. */
const CHECK_TAIL_CHARS = 8 * 1024;

/** The user's answer about checks that are not allowed yet; absent when the client has no form. */
export type CheckApprovalPrompt = (checks: readonly string[], signal: AbortSignal | null) => Promise<boolean>;

/**
 * Splits a check into its arguments; single or double quotes keep spaces together.
 * @throws `INPUT_LIMIT` for shell syntax, an open quote or an empty command.
 */
export function parseCheckCommand(command: string): string[] {
  const refuse = (reason: string) => new ToolError('INPUT_LIMIT', `Check '${command.slice(0, 120)}' ${reason}`);
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= '';
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if ('|&;<>`$()\n'.includes(char)) {
      throw refuse(`uses '${char}': it runs without a shell, so name one command and its arguments.`);
    } else {
      word = (word ?? '') + char;
    }
  }
  if (quote) throw refuse('has an open quote.');
  if (word !== null) words.push(word);
  if (!words.length || !words[0]) throw refuse('names no command.');
  return words;
}

/**
 * Makes sure the user allowed every check.
 * @param checks - The checks as written.
 * @param allowed - The exact entries of `allowedChecks`.
 * @param ask - The form; absent when the client has none.
 * @throws `POLICY_DENIED` when a check is neither allowed nor approved.
 */
export async function approveChecks(
  checks: readonly string[],
  allowed: readonly string[],
  ask: CheckApprovalPrompt | undefined,
  signal: AbortSignal | null,
): Promise<void> {
  const missing = checks.filter(check => !allowed.includes(check));
  if (!missing.length) return;
  if (!ask) {
    throw new ToolError(
      'POLICY_DENIED',
      `This client cannot ask the user to approve these checks: ${missing.join('; ')}. The user can list them in allowedChecks of the CoAgent8 configuration. No worker started.`,
    );
  }
  if (!(await ask(missing, signal))) {
    throw new ToolError('POLICY_DENIED', `The user did not approve these checks: ${missing.join('; ')}. No worker started.`);
  }
}

/** Runs one check in the work tree. Never rejects: a check that cannot start is its own result. */
export async function runCheck(command: string, cwd: string, signal: AbortSignal | null, remainingMs: number): Promise<CheckResult> {
  const started = Date.now();
  const [program, ...args] = parseCheckCommand(command);
  let output = '';
  const collect = (line: string) => {
    // Twice the tail, so one long line does not leave a cut result at every step.
    output = `${output}${line}\n`.slice(-2 * CHECK_TAIL_CHARS);
  };
  const ran = await runCommand(program!, args, {
    cwd,
    abortSignal: signal,
    timeoutMs: Math.min(CHECK_TIMEOUT_MS, remainingMs),
    maxBufferBytes: 64 * 1024,
    onStdoutLine: collect,
    onStderrLine: collect,
  });
  const status: CheckResult['status'] =
    ran.status === 'cancelled' || ran.status === 'timed_out'
      ? ran.status
      : ran.exitCode === 0
        ? 'passed'
        : ran.exitCode === null || ran.exitCode === undefined
          ? 'not_started'
          : 'failed';
  const text = output || ran.error?.message || '';
  return {
    command,
    status,
    exitCode: ran.exitCode ?? null,
    durationMs: Date.now() - started,
    // Redacted first: a cut can split a secret that the redaction would have recognized.
    tail: redactDiagnostic(text, 4 * CHECK_TAIL_CHARS).slice(-CHECK_TAIL_CHARS),
  };
}
