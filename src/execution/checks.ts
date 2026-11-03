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

/** The whole of a line is redacted, so the end of a long one survives the cut to the tail. */
const CHECK_LINE_CHARS = 1024 * 1024;
const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY/;

/**
 * How the client answered the form for checks that are not allowed yet.
 * @remarks Only `approved` and `unchecked` are the user's answer. `declined` and `unanswered` are
 * what the client returned, and clients return them without showing the form: Claude Code 2.1.317
 * in VS Code declines and Codex 0.164.0-alpha.11.1 cancels (both measured 2026-11-03, #135).
 */
export type CheckApproval = 'approved' | 'unchecked' | 'declined' | 'unanswered';

/** Asks the user about checks that are not allowed yet; absent when the client has no form. */
export type CheckApprovalPrompt = (checks: readonly string[], signal: AbortSignal | null) => Promise<CheckApproval>;

/** How the user can allow a check without a form, and who may not. */
const CHECK_APPROVAL_REMEDY =
  'Tell the user: they can list the exact commands in allowedChecks of the CoAgent8 configuration, or approve them in a client that shows MCP forms. You cannot approve them.';

/** The refusal for each answer that is not an approval. */
const REFUSALS: Record<Exclude<CheckApproval, 'approved'>, (list: string) => string> = {
  unchecked: list => `The user left 'Run these commands' unchecked for these checks: ${list}. No worker started.`,
  declined: list =>
    `The client declined the approval form for these checks: ${list}. A client may decline without showing it, so do not report this as the user's refusal unless the user says so. ${CHECK_APPROVAL_REMEDY} No worker started.`,
  unanswered: list =>
    `The client closed the approval form for these checks without an answer, possibly without showing it to the user: ${list}. ${CHECK_APPROVAL_REMEDY} No worker started.`,
};

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
 * @throws `POLICY_DENIED` when a check is neither allowed nor approved, worded by the client's answer.
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
  const answer = await ask(missing, signal);
  if (answer !== 'approved') throw new ToolError('POLICY_DENIED', REFUSALS[answer](missing.join('; ')));
}

/** Runs one check in the work tree. Never rejects: a check that cannot start is its own result. */
export async function runCheck(command: string, cwd: string, signal: AbortSignal | null, remainingMs: number): Promise<CheckResult> {
  const started = Date.now();
  const [program, ...args] = parseCheckCommand(command);
  if (remainingMs <= 0)
    return { command, status: 'timed_out', exitCode: null, durationMs: 0, tail: 'The task budget ended before this check.' };
  let output = '';
  let inPrivateKey = false;
  // Each line is redacted before the window can cut it off: a secret recognized by its beginning
  // would otherwise survive when only its end stays. A key spans lines, so it is followed here.
  const collect = (line: string) => {
    if (PRIVATE_KEY_BEGIN.test(line)) inPrivateKey = true;
    const clean = inPrivateKey ? '[REDACTED PRIVATE KEY]' : redactDiagnostic(line, CHECK_LINE_CHARS);
    if (PRIVATE_KEY_END.test(line)) inPrivateKey = false;
    output = `${output}${clean}\n`.slice(-CHECK_TAIL_CHARS);
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
      : ran.status === 'completed' && ran.exitCode === 0
        ? 'passed'
        : (ran.exitCode === null || ran.exitCode === undefined) && !ran.signal
          ? 'not_started'
          : 'failed';
  return {
    command,
    status,
    exitCode: ran.exitCode ?? null,
    durationMs: Date.now() - started,
    tail: ran.signal
      ? `${output}Ended by ${ran.signal}.`.slice(-CHECK_TAIL_CHARS)
      : output || redactDiagnostic(ran.error?.message ?? '', CHECK_TAIL_CHARS),
  };
}
