import { createGeminiCollector } from './collector.js';
import { classifyGeminiError } from './errors.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../../execution/process.js';
import { summarizeQuotaWindows } from '../quota.js';
import { redactDiagnostic } from '../../redaction.js';
import { consentRequiredMessage, isGovernedModel, isValidModelIdentifier } from '../governance.js';
import { resolveCliCommand } from '../../execution/cli-resolver.js';
import type { AdapterProbeResult, ExecutionOptions, TerminalExecutionResult, CliAdapter } from '../types.js';
import { errorCodeOf, type ExecutionError } from '../../conversation.js';

export const id = 'gemini';
export const name = 'Google Gemini (Antigravity agy)';
/** POSIX time agy gets between `SIGTERM` and `SIGKILL` to shut down its session and commands. */
const AGY_SIGNAL_GRACE_MS = 2000;
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * Model passed when the caller names none. agy keeps the model last selected in its
 * interface in internal state, so its own default is unknown before a turn and could be
 * top-tier; an explicit default keeps every agy turn governable (AUD-P1-7).
 */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash-high';
const GEMINI_CONFIG_DIR = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function resolveModelAndEffort(
  model?: string,
  reasoningEffort?: string
): { model?: string; effort?: string } {
  const effort = reasoningEffort ? reasoningEffort.toLowerCase() : undefined;
  if (!model) {
    return { model: undefined, effort };
  }
  if (effort) {
    const suffixRegex = new RegExp(`-(?:${VALID_REASONING_EFFORTS.join('|')})$`, 'i');
    const cleanModel = model.replace(suffixRegex, '');
    return { model: cleanModel, effort };
  }
  return { model, effort: undefined };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Reads agy's `/usage` payload into a measured quota.
 * @param parsed - The parsed JSON output of `agy --output-format json -p /usage`.
 * @returns The bottleneck window, or undefined when no window reports `remaining_fraction`.
 * @remarks A window without `remaining_fraction` is unmeasured, never full headroom (AUD-P2-2).
 */
export function parseGeminiUsage(parsed: unknown): AdapterProbeResult['quota'] {
  const groups = asRecord(asRecord(asRecord(parsed)?.command)?.data)?.groups;
  if (!Array.isArray(groups)) return undefined;
  const records = groups.map(asRecord).filter((group): group is Record<string, unknown> => group !== undefined);
  const geminiGroup = records.find(group => /gemini/i.test(String(group.name ?? ''))) || records[0];
  if (!geminiGroup || !Array.isArray(geminiGroup.buckets)) return undefined;

  const buckets = geminiGroup.buckets.map(asRecord)
    .filter((bucket): bucket is Record<string, unknown> => typeof bucket?.remaining_fraction === 'number')
    .map(bucket => ({
      id: String(bucket.id ?? ''),
      name: String(bucket.name ?? ''),
      window: String(bucket.window ?? ''),
      remainingFraction: bucket.remaining_fraction as number,
      resetTime: String(bucket.reset_time ?? ''),
    }));

  const quota = summarizeQuotaWindows(buckets);
  return quota && { ...quota, window: quota.window || 'weekly' };
}

export async function probe(): Promise<AdapterProbeResult> {
  const rawCommand = process.env.AGY_PATH || process.env.GEMINI_PATH || 'agy';
  let installed = false;
  let version = 'unknown';

  // runCommand resolves the command and reports a missing or failing CLI in its result.
  const res = await runCommand(rawCommand, ['--version'], { timeoutMs: 5000 });
  if (res.exitCode === 0) {
    installed = true;
    version = res.stdout.trim() || 'installed';
  }

  const authEvidence: string[] = [];
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  const antigravityDir = path.join(home, '.gemini', 'antigravity');
  const antigravityState = path.join(antigravityDir, 'antigravity_state.pbtxt');
  const oauthCreds = path.join(GEMINI_CONFIG_DIR, 'oauth_creds.json');
  const googleAccounts = path.join(GEMINI_CONFIG_DIR, 'google_accounts.json');

  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
  const hasAntigravityState = fs.existsSync(antigravityState);
  const hasOauth = fs.existsSync(oauthCreds) || fs.existsSync(googleAccounts);

  if (hasApiKey) authEvidence.push('API key present (not verified)');
  if (hasAntigravityState) authEvidence.push('Antigravity state present (not verified)');
  if (hasOauth) authEvidence.push('Google OAuth credentials present (not verified)');
  if (authEvidence.length === 0) authEvidence.push('No local auth evidence');

  // Authentication is proven only by an execution or the quota read (`inspectQuota`).
  const authStatus = 'unknown';

  return {
    id,
    name,
    command: rawCommand,
    installed,
    version,
    executionSupported: installed,
    capabilities: {
      resume: true,
      streaming: true,
      readOnlyVerified: true,
      reasoningEffort: true,
    },
    authStatus,
    authEvidence,
    availableModels: [
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'gemini-3.7-flash-high',
      'gemini-3.7-flash-medium',
      'gemini-3.7-flash-low',
      'gemini-3.6-flash-high',
      'gemini-3.6-flash-medium',
      'gemini-3.6-flash-low',
      'gemini-3.1-pro-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ],
    supportedReasoningEfforts: VALID_REASONING_EFFORTS,
    config: { defaultModel: GEMINI_DEFAULT_MODEL },
    modelSource: 'Antigravity CLI model catalog; the bridge defaults to ' + GEMINI_DEFAULT_MODEL,
    loginHint: 'agy',
  };
}

/**
 * Reads agy's measured quota with `/usage`, which makes no model call.
 * @param probe - An installed probe result; nothing is read without one.
 * @returns The measured quota, or undefined when agy does not report one.
 * @remarks Runs only from quota inspection (doctor), never on the request path, and with
 * the same `--sandbox` as every other agy launch.
 */
export async function inspectQuota(probe?: AdapterProbeResult): Promise<AdapterProbeResult['quota']> {
  if (!probe?.installed) return undefined;
  const resolved = resolveCliCommand(process.env.AGY_PATH || process.env.GEMINI_PATH || 'agy');
  const usageRes = await runCommand(resolved.command, [...resolved.argsPrefix, '--sandbox', '--output-format', 'json', '-p', '/usage'], { timeoutMs: 5000 });
  if (usageRes.exitCode !== 0 || !usageRes.stdout) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(usageRes.stdout); } catch { return undefined; }
  const payload = parsed as { status?: unknown; command?: { name?: unknown } } | null;
  return payload?.status === 'SUCCESS' && payload.command?.name === 'usage' ? parseGeminiUsage(payload) : undefined;
}

function failed(error: ExecutionError): TerminalExecutionResult {
  return { status: 'failed', isError: true, output: '', error, errorDetail: error.message, truncated: false, continuationAvailable: false };
}

/**
 * Runs one agy turn in its read-only sandbox.
 * @remarks The deadline and cancellation are `runCommand`'s: it validates `timeoutMs`, stops the
 * process and reports `timed_out` or `cancelled`, which this result keeps.
 */
/** Returns the requested model, or the bridge default {@link GEMINI_DEFAULT_MODEL}. */
export function resolveModel(requested?: string): string {
  return requested || GEMINI_DEFAULT_MODEL;
}

export async function execute(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  if (options.model && !isValidModelIdentifier(options.model)) {
    return failed({ code: 'INPUT_LIMIT', message: 'Invalid Gemini model identifier.', retryable: false });
  }
  const model = resolveModel(options.model);
  if (isGovernedModel(model) && options.consentedModel !== model) {
    return failed({ code: 'POLICY_DENIED', message: consentRequiredMessage(model), retryable: false });
  }
  if (options.abortSignal?.aborted) {
    return { ...failed({ code: 'ABORTED', message: 'Cancelled before launch.', retryable: false }), status: 'cancelled' };
  }
  const native = options.nativeSessionId || options.threadId;
  if (native && !UUID.test(native)) {
    return failed({ code: 'SESSION_INVALID', message: 'Gemini resume requires an exact full UUID.', retryable: false });
  }
  if (options.reasoningEffort) {
    const norm = options.reasoningEffort.toLowerCase();
    if (!VALID_REASONING_EFFORTS.includes(norm)) {
      return failed({ code: 'CLI_UNSUPPORTED', message: `Invalid reasoning effort '${options.reasoningEffort}'. Valid: ${VALID_REASONING_EFFORTS.join(', ')}`, retryable: false });
    }
  }

  const rawCommand = process.env.AGY_PATH || process.env.GEMINI_PATH || 'agy';
  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    resolved = resolveCliCommand(rawCommand);
  } catch (err) {
    return failed({
      code: errorCodeOf(err) === 'CLI_UNSUPPORTED' ? 'CLI_UNSUPPORTED' : 'CLI_NOT_FOUND',
      message: redactDiagnostic((err as Error).message),
      retryable: false,
    });
  }

  const { model: targetModel, effort: targetEffort } = resolveModelAndEffort(model, options.reasoningEffort);

  const collector = createGeminiCollector(options.onEvent);
  const args = [...resolved.argsPrefix, '--sandbox', '--output-format', 'stream-json'];
  if (options.cwd) {
    args.push('--add-dir', path.resolve(options.cwd));
  }
  if (targetModel) {
    args.push('--model', targetModel);
  }
  if (targetEffort) {
    args.push('--effort', targetEffort);
  }
  if (native) {
    args.push('--conversation', native);
  }

  const processResult = await runCommand(resolved.command, args, {
    cwd: options.cwd ? path.resolve(options.cwd) : process.cwd(),
    stdinInput: prompt,
    abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs,
    // agy has no headless interrupt; on POSIX, SIGTERM lets it cancel its own commands first.
    signalGraceMs: AGY_SIGNAL_GRACE_MS,
    maxBufferBytes: 512 * 1024,
    maxLineBytes: 512 * 1024,
    onStdoutLine: collector.line,
    onStderrLine(line) {
      if (/jetski:.*auto-denied/i.test(line)) {
        collector.denySandbox();
      }
    },
  });


  const s = collector.snapshot();
  // A denied action shows that the sandbox works; the answer stays, as with Claude permission denials.
  if (s.sandboxDenied) options.onEvent?.({ type: 'warning', message: 'The agy sandbox denied an action outside the read-only profile; the answer may be incomplete.' });
  let error: ExecutionError | undefined = processResult.error || s.terminalError;
  if (!error && processResult.status !== 'completed') {
    const fallbackStderr = processResult.stderr ? processResult.stderr.trim() : '';
    error = fallbackStderr
      ? classifyGeminiError(fallbackStderr)
      : { code: 'PROCESS_ERROR', message: `Gemini process failed with status ${processResult.status} (exit code ${processResult.exitCode}).`, retryable: false };
  }
  if (!error && (!s.terminal || !s.nativeSessionId)) {
    error = { code: 'PROTOCOL_ERROR', message: 'Gemini omitted its terminal result or init metadata.', retryable: false };
  }
  if (!error && native && s.nativeSessionId !== native) {
    error = { code: 'SESSION_INVALID', message: 'Resume returned a different Gemini session.', retryable: false };
  }

  const status = processResult.status === 'cancelled' || processResult.status === 'timed_out' ? processResult.status : error ? 'failed' : 'completed';
  return {
    ...s,
    // agy may omit the model from `init`; then the requested model is the best known.
    model: s.model ?? targetModel,
    status,
    isError: status !== 'completed',
    error,
    errorDetail: error?.message,
    threadId: s.nativeSessionId,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    truncated: processResult.isTruncated || s.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable: !!(s.nativeSessionId || native) && !['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(error?.code || ''),
  };
}

export const geminiAdapter: CliAdapter = { id, name, probe, resolveModel, execute, inspectQuota };
export default geminiAdapter;
