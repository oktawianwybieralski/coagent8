import { createGeminiCollector } from './collector.js';
import { classifyGeminiError } from './errors.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runCommand } from '../../execution/process.js';
import { summarizeQuotaWindows } from '../quota.js';
import { redactDiagnostic } from '../../security/redaction.js';
import { isValidModelIdentifier } from '../../models/identifier.js';
import { resolveCliCommand } from '../../execution/cli-resolver.js';
import { turnEnvironment } from '../../execution/nested-turn.js';
import { configuredBackendCommand, probeCommand } from '../executable.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MODEL_LIST_TIMEOUT_MS,
  type AdapterProbeResult,
  type BackendReadContext,
  type CatalogModel,
  type ExecutionOptions,
  type InheritedTools,
  type ModelCatalog,
  type TerminalExecutionResult,
  type CliAdapter,
} from '../types.js';
import { errorCodeOf, ToolError, type AdapterEvent, type ExecutionError } from '../../contracts/index.js';

export const id = 'agy';
export const name = 'Google Gemini (Antigravity agy)';
/** POSIX time agy gets between `SIGTERM` and `SIGKILL` to shut down its session and commands. */
const AGY_SIGNAL_GRACE_MS = 2000;
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GEMINI_CONFIG_DIR = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/**
 * Sent once on `--conversation <id>` when an `agy --sandbox` turn ends without an answer
 * because headless mode auto-denied a shell command (#20).
 */
export const SANDBOX_DENIAL_RECOVERY_PROMPT =
  'Your sandbox denied a shell command and your previous turn ended without an answer. Answer the previous request now, in the format it asks for. Run no shell command: read files only with your file tools, or answer from what you already know and say what you could not check.';

function prefixRetryId(id: string): string {
  const prefixed = `retry-${id}`;
  return Buffer.byteLength(prefixed, 'utf8') <= 256 ? prefixed : prefixed.slice(0, 256);
}

function mergeUsage(
  first: TerminalExecutionResult['usage'],
  second: TerminalExecutionResult['usage']
): TerminalExecutionResult['usage'] {
  if (!first || !second) return undefined;
  const merged: NonNullable<TerminalExecutionResult['usage']> = { source: 'provider' };
  if (typeof first.inputTokens === 'number' && typeof second.inputTokens === 'number') {
    merged.inputTokens = first.inputTokens + second.inputTokens;
  }
  if (typeof first.outputTokens === 'number' && typeof second.outputTokens === 'number') {
    merged.outputTokens = first.outputTokens + second.outputTokens;
  }
  if (typeof first.totalTokens === 'number' && typeof second.totalTokens === 'number') {
    merged.totalTokens = first.totalTokens + second.totalTokens;
  }
  return merged;
}

/** Caps caller timeout to the operation's default bound (`EXEC-001-T08e`). */
function boundReadTimeout(context: BackendReadContext | undefined, defaultMs: number): number {
  if (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0) {
    return Math.min(context.timeoutMs, defaultMs);
  }
  return defaultMs;
}

function effectiveAbortSignal(context?: BackendReadContext): AbortSignal | undefined {
  return context?.abortSignal ?? context?.budget?.executionSignal;
}

function checkPreflight(context: BackendReadContext | undefined, operation: string): void {
  const signal = effectiveAbortSignal(context);
  if (signal?.aborted) {
    throw new ToolError('ABORTED', `${operation} cancelled before launch.`);
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', `Execution budget expired before ${operation.toLowerCase()}.`);
  }
}

function checkPostRun(
  res: { status: string; error?: { code?: string } },
  context: BackendReadContext | undefined,
  operation: string
): void {
  const signal = effectiveAbortSignal(context);
  if (signal?.aborted || res.error?.code === 'ABORTED' || res.status === 'cancelled') {
    if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
      throw new ToolError('TIMEOUT', `Execution budget expired during ${operation.toLowerCase()}.`);
    }
    throw new ToolError('ABORTED', `${operation} cancelled.`);
  }
  if (res.status !== 'completed' && (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut())) {
    throw new ToolError('TIMEOUT', `Execution budget expired during ${operation.toLowerCase()}.`);
  }
}

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

/**
 * Environment of every agy launch, with agy's auto-updater disabled.
 * @remarks agy 1.3.1 starts a background updater on its first launch after 15 minutes. On
 * Windows that updater starts another agy with a new console window, which takes the keyboard
 * focus for about half a second (WINDOWS-001, measured 2026-10-07). agy honours only `true`.
 */
function agyEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
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

export async function probe(context?: BackendReadContext): Promise<AdapterProbeResult> {
  checkPreflight(context, 'Gemini probe');
  const resolvedCommand = probeCommand('agy', name);
  if ('unresolved' in resolvedCommand) return resolvedCommand.unresolved;
  const rawCommand = resolvedCommand.command;
  let installed = false;
  let version = 'unknown';

  // runCommand resolves the command and reports a missing or failing CLI in its result.
  const res = await runCommand(rawCommand, ['--version'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_PROBE_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    env: agyEnvironment(),
  });
  checkPostRun(res, context, 'Gemini probe');
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
    // Models come from `agy models` (`listModels`), read on demand.
    supportedReasoningEfforts: VALID_REASONING_EFFORTS,
    modelSource: 'agy models; the default is the configured one, else the first model agy lists',
    loginHint: 'agy',
  };
}

/**
 * Reads agy's measured quota with `/usage`, which makes no model call.
 * @param probe - An installed probe result; nothing is read without one.
 * @param context - Optional cancellation and deadline context (`EXEC-001-T08e`).
 * @returns The measured quota, or undefined when agy does not report one.
 * @remarks Runs only from quota inspection (doctor), never on the request path, and with
 * the same `--sandbox` as every other agy launch.
 */
export async function inspectQuota(probe?: AdapterProbeResult, context?: BackendReadContext): Promise<AdapterProbeResult['quota']> {
  checkPreflight(context, 'Gemini quota read');
  if (!probe?.installed) return undefined;
  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch {
    return undefined;
  }
  const usageRes = await runCommand(resolved.command, [...resolved.argsPrefix, '--sandbox', '--output-format', 'json', '-p', '/usage'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_PROBE_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    env: agyEnvironment(),
  });
  checkPostRun(usageRes, context, 'Gemini quota read');
  if (usageRes.status !== 'completed' || usageRes.exitCode !== 0 || !usageRes.stdout) return undefined;
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
 * @remarks Every turn passes `--model`: agy keeps the model last selected in its interface
 * in internal state, so its own choice is unknown before the turn and could be top-tier
 * (AUD-P1-7). The deadline and cancellation are `runCommand`'s: it validates `timeoutMs`,
 * stops the process and reports `timed_out` or `cancelled`, which this result keeps.
 * When a headless sandbox denial ends the turn with an empty answer, `execute` resumes the
 * same native conversation at most once within the remaining `timeoutMs` and `abortSignal`
 * to ask for an answer without shell commands (#20).
 */
export async function execute(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  const model = options.model;
  if (model === undefined) {
    return failed({ code: 'INPUT_LIMIT', message: 'No agy model selected; the controller passes the configured model or the first one agy lists.', retryable: false });
  }
  if (!isValidModelIdentifier(model)) {
    return failed({ code: 'INPUT_LIMIT', message: 'Invalid Gemini model identifier.', retryable: false });
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

  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    // A configured executable that is missing fails here like an absent CLI.
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch (err) {
    return failed({
      code: errorCodeOf(err) === 'CLI_UNSUPPORTED' ? 'CLI_UNSUPPORTED' : 'CLI_NOT_FOUND',
      message: redactDiagnostic((err as Error).message),
      retryable: false,
    });
  }

  const { model: targetModel, effort: targetEffort } = resolveModelAndEffort(model, options.reasoningEffort);

  const baseArgs = [...resolved.argsPrefix, '--sandbox', '--output-format', 'stream-json'];
  if (options.cwd) {
    baseArgs.push('--add-dir', path.resolve(options.cwd));
  }
  if (targetModel) {
    baseArgs.push('--model', targetModel);
  }
  if (targetEffort) {
    baseArgs.push('--effort', targetEffort);
  }

  const resolvedCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const env = turnEnvironment(agyEnvironment());

  const runTurn = async (
    turnPrompt: string,
    conversationId: string | null | undefined,
    timeoutMs: number | undefined,
    onEvent: ((event: AdapterEvent) => void) | undefined
  ) => {
    const collector = createGeminiCollector(onEvent);
    const args = conversationId ? [...baseArgs, '--conversation', conversationId] : [...baseArgs];
    const processResult = await runCommand(resolved.command, args, {
      cwd: resolvedCwd,
      env,
      stdinInput: turnPrompt,
      abortSignal: options.abortSignal,
      timeoutMs,
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
    return { processResult, snapshot: collector.snapshot() };
  };

  const startedAtMs = performance.now();
  const first = await runTurn(prompt, native, options.timeoutMs, options.onEvent);
  let processResult = first.processResult;
  let s = first.snapshot;
  let retriedAfterDenial = false;

  const canRetryEmptyDenial =
    processResult.status === 'completed' &&
    !processResult.error &&
    !s.terminalError &&
    s.terminal &&
    Boolean(s.nativeSessionId) &&
    (!native || s.nativeSessionId === native) &&
    s.sandboxDenied &&
    !s.output.trim() &&
    !options.abortSignal?.aborted;

  if (canRetryEmptyDenial) {
    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAtMs));
    const remainingTimeoutMs = options.timeoutMs !== undefined ? options.timeoutMs - elapsedMs : undefined;
    if (remainingTimeoutMs === undefined || remainingTimeoutMs > 0) {
      retriedAfterDenial = true;
      const retrySessionId = s.nativeSessionId!;
      const retryOnEvent = options.onEvent
        ? (event: AdapterEvent) => {
            if ((event.type === 'assistant_delta' || event.type === 'assistant_message') && event.messageId !== 'final') {
              options.onEvent?.({ ...event, messageId: prefixRetryId(event.messageId) });
            } else if (event.type === 'tool_started' || event.type === 'tool_finished') {
              options.onEvent?.({ ...event, toolId: prefixRetryId(event.toolId) });
            } else {
              options.onEvent?.(event);
            }
          }
        : undefined;
      const second = await runTurn(SANDBOX_DENIAL_RECOVERY_PROMPT, retrySessionId, remainingTimeoutMs, retryOnEvent);
      processResult = second.processResult;
      const s2 = second.snapshot;
      s = {
        ...s2,
        model: s2.model ?? s.model,
        sandboxDenied: s.sandboxDenied || s2.sandboxDenied,
        truncated: s.truncated || s2.truncated,
        usage: mergeUsage(s.usage, s2.usage),
      };
    }
  }

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
  // A headless denial ends agy's turn before the model answers; an empty success is no answer.
  if (!error && s.sandboxDenied && !s.output.trim()) {
    error = {
      code: 'POLICY_DENIED',
      message: retriedAfterDenial
        ? 'agy ended the turn without an answer after its sandbox denied a command, including on automatic retry without shell commands (headless mode cannot ask for permission).'
        : 'agy ended the turn without an answer after its sandbox denied a command (headless mode cannot ask for permission). Ask again for an answer that reads files without running commands.',
      retryable: false,
    };
  }
  const expectedSessionId = retriedAfterDenial ? first.snapshot.nativeSessionId : native;
  if (!error && expectedSessionId && s.nativeSessionId !== expectedSessionId) {
    error = { code: 'SESSION_INVALID', message: 'Resume returned a different Gemini session.', retryable: false };
  }
  const effectiveSessionId = error?.code === 'SESSION_INVALID' || error?.code === 'PROTOCOL_ERROR'
    ? s.nativeSessionId
    : (s.nativeSessionId ?? expectedSessionId ?? null);

  const status = processResult.status === 'cancelled' || processResult.status === 'timed_out' ? processResult.status : error ? 'failed' : 'completed';
  return {
    ...s,
    nativeSessionId: effectiveSessionId,
    // agy may omit the model from `init`; then the requested model is the best known.
    model: s.model ?? targetModel,
    status,
    isError: status !== 'completed',
    error,
    errorDetail: error?.message,
    threadId: effectiveSessionId,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    // The collector owns the answer; the runner's bounded stdout copy of the event stream is diagnostic.
    truncated: s.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable: !!(effectiveSessionId || native) && !['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(error?.code || ''),
  };
}

/**
 * Groups `agy models` lines (`<id>\t<display name>`) by effort: agy lists
 * `gemini-3.8-flash-high` and accepts `--model gemini-3.8-flash --effort high`, but rejects
 * `gemini-3.8-flash` without an effort.
 */
export function parseAgyModels(stdout: string): CatalogModel[] {
  const suffix = new RegExp(`^(.+)-(${VALID_REASONING_EFFORTS.join('|')})$`);
  const models: CatalogModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const modelId = line.split('\t')[0].trim();
    if (!line.includes('\t') || !isValidModelIdentifier(modelId)) continue;
    const match = suffix.exec(modelId);
    if (!match) { models.push({ id: modelId, efforts: [] }); continue; }
    const group = models.find(model => model.id === match[1] && model.effortRequired);
    if (group) group.efforts.push(match[2]);
    else models.push({ id: match[1], efforts: [match[2]], effortRequired: true });
  }
  return models;
}

/** Reads the models agy offers with `agy models`, which makes no model call (about 2 s). */
export async function listModels(_probe?: AdapterProbeResult, context?: BackendReadContext): Promise<ModelCatalog | undefined> {
  checkPreflight(context, 'Gemini model list');
  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch {
    // Without a resolvable agy there is no catalog; the turn itself reports why agy cannot run.
    return undefined;
  }
  const res = await runCommand(resolved.command, [...resolved.argsPrefix, 'models'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_MODEL_LIST_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    env: agyEnvironment(),
  });
  checkPostRun(res, context, 'Gemini model list');
  if (res.status !== 'completed' || res.exitCode !== 0 || !res.stdout) return undefined;
  const models = parseAgyModels(res.stdout);
  return models.length ? { models, source: 'agy models' } : undefined;
}

/** Names of the enabled servers in an `agy mcp list` table (`NAME  TYPE  STATUS  COMMAND/URL`). */
export function parseAgyMcpList(stdout: string): string[] {
  return stdout.split(/\r?\n/).map(line => line.trim().split(/\s{2,}/))
    .filter(columns => columns.length >= 3 && columns[0] !== 'NAME' && columns[2] === 'enabled')
    .map(columns => columns[0]);
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try { return asRecord(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Plugin directories agy discovers in the global customization root and keeps enabled: a
 * `plugins` entry in `config.json` wins, otherwise the plugin's own `disabled` declaration.
 * @remarks `agy plugin list` names only imported plugins, not discovered ones (agy 1.3.1).
 */
export function listAgyPlugins(configDir = path.join(GEMINI_CONFIG_DIR, 'config')): string[] {
  const root = path.join(configDir, 'plugins');
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const settings = asRecord(readJsonObject(path.join(configDir, 'config.json'))?.plugins);
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).filter(dir => {
    const manifest = readJsonObject(path.join(root, dir, 'plugin.json'));
    if (!manifest) return false;
    const enabled = asRecord(settings?.[dir])?.enabled;
    return typeof enabled === 'boolean' ? enabled : manifest.disabled !== true;
  });
}

/**
 * Reads the MCP servers and plugins agy offers its model in every turn, `--sandbox` included,
 * without a model call. CoAgent8 cannot disable them (CUR-002); doctor names them.
 * @returns The inherited tools, or undefined when agy cannot be run or read.
 */
export async function inheritedTools(context?: BackendReadContext): Promise<InheritedTools | undefined> {
  checkPreflight(context, 'Gemini inherited tools read');
  let resolved: ReturnType<typeof resolveCliCommand>;
  try { resolved = resolveCliCommand(configuredBackendCommand('agy')); }
  catch { return undefined; }
  const res = await runCommand(resolved.command, [...resolved.argsPrefix, 'mcp', 'list'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_MODEL_LIST_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    env: agyEnvironment(),
  });
  checkPostRun(res, context, 'Gemini inherited tools read');
  if (res.status !== 'completed' || res.exitCode !== 0) return undefined;
  let plugins: string[];
  try { plugins = listAgyPlugins(); }
  catch { return undefined; }
  return { mcpServers: parseAgyMcpList(res.stdout), plugins };
}

// `resolveModelAndEffort` drops a model's effort suffix when an effort is passed separately.
export const agyAdapter: CliAdapter = { id, name, effortReplacesModelSuffix: true, probe, execute, inspectQuota, listModels, inheritedTools };
export default agyAdapter;
