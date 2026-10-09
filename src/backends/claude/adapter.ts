import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runCommand, type StdinChannel, type StdinSession } from '../../execution/process.js';
import { redactDiagnostic } from '../../security/redaction.js';
import { isValidModelIdentifier } from '../../models/identifier.js';
import { createClaudeStreamCollector } from './collector.js';
import { parseClaudeUsage } from './usage.js';
import { DEFAULT_PROBE_TIMEOUT_MS, type AdapterProbeResult, type BackendReadContext, type CatalogModel, type ExecutionOptions, type ModelCatalog, type TerminalExecutionResult, type CliAdapter } from '../types.js';
import { ToolError, type ExecutionError } from '../../contracts/index.js';
import { MIN_CLAUDE_VERSION, supportsClaudeVersion } from './version.js';
import { turnEnvironment } from '../../execution/nested-turn.js';
import { configuredBackendCommand, probeCommand } from '../executable.js';
export const id = 'claude', name = 'Claude Code CLI';
/** Built-in tools of the read-only profile; `--restricted` removes every code-running tool not named here. */
export const CLAUDE_READ_ONLY_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const claudeCommand = () => configuredBackendCommand('claude');
/** User settings, which can choose the default model; a change invalidates cached probes and observed models. */
const claudeSettingsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

/** Caps caller timeout to the operation's default bound (`EXEC-001-T08d`). */
function boundReadTimeout(context: BackendReadContext | undefined, defaultMs: number): number {
  if (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0) {
    return Math.min(context.timeoutMs, defaultMs);
  }
  return defaultMs;
}

/**
 * Reads installation, version and local login state without calling a model.
 * @remarks `claude auth status` reports the CLI's own login state (exit 0 when
 * logged in, 1 when not). Token validity is proven only by an execution.
 * Read-only enforcement is checked on every run against `system/init`.
 */
export async function probe(context?: BackendReadContext): Promise<AdapterProbeResult> {
  const abortSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Claude probe cancelled before launch.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before probing Claude.');
  }
  const resolved = probeCommand('claude', name);
  if ('unresolved' in resolved) return resolved.unresolved;
  const command = resolved.command;
  const res = await runCommand(command, ['--version'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_PROBE_TIMEOUT_MS),
    abortSignal,
  });
  if (abortSignal?.aborted || res.error?.code === 'ABORTED' || res.status === 'cancelled') {
    if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
      throw new ToolError('TIMEOUT', 'Execution budget expired during Claude probe.');
    }
    throw new ToolError('ABORTED', 'Claude probe cancelled.');
  }
  if (res.status !== 'completed' && (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut())) {
    throw new ToolError('TIMEOUT', 'Execution budget expired during Claude probe.');
  }
  const installed = res.status === 'completed';
  const version = res.stdout.trim() || 'unknown';
  const executionSupported = installed && supportsClaudeVersion(version);
  let authStatus = 'unknown', authMethod: string | undefined;
  const authEvidence: string[] = [];
  if (installed) {
    if (abortSignal?.aborted) {
      throw new ToolError('ABORTED', 'Claude probe cancelled before reading auth status.');
    }
    if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
      throw new ToolError('TIMEOUT', 'Execution budget expired before reading Claude auth status.');
    }
    const auth = await runCommand(command, ['auth', 'status', '--json'], {
      timeoutMs: boundReadTimeout(context, 10000),
      abortSignal,
    });
    if (abortSignal?.aborted || auth.error?.code === 'ABORTED' || auth.status === 'cancelled') {
      if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
        throw new ToolError('TIMEOUT', 'Execution budget expired during Claude probe.');
      }
      throw new ToolError('ABORTED', 'Claude probe cancelled.');
    }
    if (auth.status !== 'completed' && (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut())) {
      throw new ToolError('TIMEOUT', 'Execution budget expired during Claude probe.');
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(auth.stdout);
      parsed = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      authEvidence.push(`claude auth status returned no JSON (${auth.error?.code ?? `exit ${auth.exitCode}`}).`);
    }
    if (parsed && typeof parsed.loggedIn === 'boolean') {
      authStatus = parsed.loggedIn ? 'authenticated' : 'unauthenticated';
      authMethod = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined;
      authEvidence.push(`claude auth status: loggedIn=${parsed.loggedIn}${authMethod ? `, authMethod=${authMethod}` : ''}; token validity is proven only by an execution.`);
    }
  } else authEvidence.push('Claude Code CLI not found.');
  if (installed && !executionSupported) authEvidence.push(`Claude Code ${version} is older than ${MIN_CLAUDE_VERSION.join('.')}, which the restricted profile and model reporting need.`);
  return { id, name, installed, version, command, configPath: claudeSettingsPath(), authStatus, authMethod, authEvidence, loginHint: 'claude auth login',
    supportedReasoningEfforts: VALID_REASONING_EFFORTS,
    modelSource: 'models and aliases from stream-json initialize; an unlisted name is resolved from system/init', executionSupported,
    capabilities: { resume: true, streaming: true, readOnlyVerified: executionSupported, reasoningEffort: true } };
}

/**
 * Runs `claude -p /usage`, a local command, in the restricted profile with stream-json output.
 * @param model - The `--model` to pass; omitted for the model Claude Code runs without one.
 * @param probe - Probe result whose version is checked; `--version` runs when it has none.
 * @param context - Optional cancellation and deadline context (`EXEC-001-T08d`).
 * @returns The model `system/init` reports and the usage text, or undefined when the CLI is
 * older than {@link MIN_CLAUDE_VERSION}, fails, or reports any model turn or cost.
 * @remarks Nothing reaches a model on a verified version; a turn or cost a later version
 * might report discards the run.
 */
async function runLocalUsage(
  model: string | undefined,
  probe?: AdapterProbeResult,
  context?: BackendReadContext
): Promise<{ model?: string; usage: string } | undefined> {
  const abortSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Claude usage read cancelled before launch.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before reading Claude usage.');
  }
  let version = probe?.version;
  if (!version || version === 'unknown') {
    const verRes = await runCommand(claudeCommand(), ['--version'], {
      timeoutMs: boundReadTimeout(context, DEFAULT_PROBE_TIMEOUT_MS),
      abortSignal,
    });
    if (abortSignal?.aborted || verRes.error?.code === 'ABORTED' || verRes.status === 'cancelled') {
      if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
        throw new ToolError('TIMEOUT', 'Execution budget expired reading Claude version.');
      }
      throw new ToolError('ABORTED', 'Claude usage read cancelled.');
    }
    if (verRes.status !== 'completed') {
      if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
        throw new ToolError('TIMEOUT', 'Execution budget expired reading Claude version.');
      }
      return undefined;
    }
    version = verRes.stdout.trim();
  }
  if (!supportsClaudeVersion(version)) return undefined;

  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Claude usage read cancelled before running usage command.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before running Claude usage command.');
  }

  const res = await runCommand(claudeCommand(), ['-p', '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    ...(model ? ['--model', model] : []), '--output-format', 'stream-json', '--verbose', '/usage'], {
    timeoutMs: boundReadTimeout(context, 15000),
    abortSignal,
  });
  if (abortSignal?.aborted || res.error?.code === 'ABORTED' || res.status === 'cancelled') {
    if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
      throw new ToolError('TIMEOUT', 'Execution budget expired during Claude usage read.');
    }
    throw new ToolError('ABORTED', 'Claude usage read cancelled.');
  }
  if (res.status !== 'completed' && (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut())) {
    throw new ToolError('TIMEOUT', 'Execution budget expired during Claude usage read.');
  }
  if (res.status !== 'completed') return undefined;
  let reported: unknown, result: Record<string, unknown> | undefined;
  for (const line of res.stdout.split(/\r?\n/)) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; }
    catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init') reported = event.model;
    else if (event?.type === 'result') result = event;
  }
  if (result?.is_error !== false || result.local_command !== 'usage' || result.num_turns !== 0 || result.total_cost_usd !== 0 || typeof result.result !== 'string') return undefined;
  return { ...(isValidModelIdentifier(reported) ? { model: reported } : {}), usage: result.result };
}

/**
 * Reads subscription limits from `claude -p /usage`, a local command that makes no model call.
 * @param probe - Optional probe result with pre-collected version to avoid re-invoking `--version`.
 * @param context - Optional cancellation and deadline context (`EXEC-001-T08d`).
 * @returns Measured quota, or `undefined` when the CLI is older than the verified version,
 * the run reports a model turn or cost, or it prints no limits (API-key billing).
 */
export async function inspectQuota(probe?: AdapterProbeResult, context?: BackendReadContext): Promise<AdapterProbeResult['quota']> {
  const abortSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Claude quota read cancelled before launch.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before reading Claude quota.');
  }
  const run = await runLocalUsage(undefined, probe, context);
  return run ? parseClaudeUsage(run.usage) : undefined;
}

/**
 * Asks Claude Code which concrete model it runs for a name or alias, or without one (its
 * account default, as the restricted profile sees it), from `system/init` of a local
 * `/usage` run: no model turn and no cost.
 * @param requested - The model or alias; omitted for the default.
 * @param probe - Probe result whose version is checked.
 * @param context - Optional cancellation and deadline context (`EXEC-001-T08d`).
 */
export async function observeModel(requested?: string, probe?: AdapterProbeResult, context?: BackendReadContext): Promise<string | undefined> {
  const abortSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Claude model observation cancelled before launch.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before observing Claude model.');
  }
  if (requested !== undefined && !isValidModelIdentifier(requested)) return undefined;
  return (await runLocalUsage(requested, probe, context))?.model;
}

/** Upper bound for the catalog read; 0.9 s measured on Claude Code 2.1.294 (2026-10-08). */
const MODEL_LIST_TIMEOUT_MS = 15_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reads the model list of a stream-json `initialize` control response (Claude Code 2.1.294):
 * entries `{ value, resolvedModel, supportedEffortLevels }`, where `value` is a name the CLI
 * accepts and `resolvedModel` the concrete model it runs. Entries resolving to one model
 * become one catalog model with the other names as aliases; the `default` entry marks the
 * account default.
 * @returns The catalog, or undefined when the response lists no valid model.
 */
export function parseClaudeModels(response: unknown): ModelCatalog | undefined {
  const entries = record(response)?.models;
  if (!Array.isArray(entries)) return undefined;
  const models = new Map<string, CatalogModel>();
  for (const item of entries.map(record)) {
    const value = item?.value;
    const concrete = item?.resolvedModel ?? value;
    if (!isValidModelIdentifier(value) || !isValidModelIdentifier(concrete)) continue;
    const efforts = Array.isArray(item!.supportedEffortLevels) ? item!.supportedEffortLevels.filter((effort): effort is string => typeof effort === 'string' && VALID_REASONING_EFFORTS.includes(effort)) : [];
    const model = models.get(concrete) ?? { id: concrete, efforts };
    if (value !== concrete && !model.aliases?.includes(value)) model.aliases = [...model.aliases ?? [], value];
    if (value === 'default') model.isDefault = true;
    models.set(concrete, model);
  }
  return models.size ? { models: [...models.values()], source: 'claude stream-json initialize', acceptsUnlisted: true } : undefined;
}

/**
 * Lists the models Claude Code offers, with the concrete model each alias runs, from the
 * `initialize` control request of a restricted stream-json session that receives no user
 * message: no model turn and no cost.
 * @param probe - The current probe; an unsupported version is not asked.
 * @param context - Optional cancellation and deadline context (`EXEC-001-T08d`).
 * @returns The catalog, or undefined when the CLI does not answer, is older than
 * {@link MIN_CLAUDE_VERSION}, or reports a turn or result, which discards the run.
 */
export async function listModels(probe?: AdapterProbeResult, context?: BackendReadContext): Promise<ModelCatalog | undefined> {
  const abortSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Claude model list cancelled before launch.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before reading Claude models.');
  }
  if (probe && !probe.executionSupported) return undefined;
  const requestId = randomUUID();
  let channel: StdinChannel | undefined, response: unknown, turned = false;
  const timeoutMs = boundReadTimeout(context, MODEL_LIST_TIMEOUT_MS);
  try {
    const result = await runCommand(claudeCommand(), ['-p', '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      timeoutMs, maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024,
      abortSignal,
      session: {
        start(opened) { channel = opened; opened.send({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }); },
        interrupt(opened) { opened.close(); },
      },
      onStdoutLine(line) {
        let event: Record<string, unknown> | null;
        try { event = record(JSON.parse(line)); } catch { event = null; }
        if (!event) return;
        if (event.type === 'result' || event.type === 'assistant') turned = true;
        const answer = record(event.response);
        if (event.type === 'control_response' && answer?.request_id === requestId) {
          response = answer.subtype === 'success' ? answer.response : undefined;
          // Closing stdin before any user message ends the session without a turn.
          channel?.close();
        }
      },
    });
    if (abortSignal?.aborted || result.error?.code === 'ABORTED' || result.status === 'cancelled') {
      if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
        throw new ToolError('TIMEOUT', 'Execution budget expired reading Claude models.');
      }
      throw new ToolError('ABORTED', 'Claude model list cancelled.');
    }
    if (result.status !== 'completed' && (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut())) {
      throw new ToolError('TIMEOUT', 'Execution budget expired reading Claude models.');
    }
    if (turned || result.status !== 'completed') return undefined;
    return parseClaudeModels(response);
  } finally {
    channel?.close();
  }
}

/**
 * Runs one Claude Code turn in restricted, read-only print mode.
 * @remarks Subscription (OAuth) and API-key authentication both work. Each run
 * fails closed with `SANDBOX_UNAVAILABLE` unless `system/init` reports only
 * {@link CLAUDE_READ_ONLY_TOOLS}, no MCP server and `dontAsk`. A new turn
 * pins a fresh `--session-id`; a continuation passes `--resume`. The prompt is one
 * stream-json user message on stdin, which stays open so cancellation and deadlines
 * can interrupt the turn (`control_request` `interrupt`) before the process is stopped.
 */
export async function executeClaude(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  const rejected = (code: ExecutionError['code'], message: string, model?: string): TerminalExecutionResult => ({
    status: 'failed', isError: true, output: '', model, error: { code, message: redactDiagnostic(message), retryable: false }, errorDetail: redactDiagnostic(message), truncated: false, continuationAvailable: false,
  });
  const model: unknown = options.model;
  if (model === undefined) return rejected('INPUT_LIMIT', 'No Claude model selected; the controller passes the model Claude Code reported.');
  if (!isValidModelIdentifier(model)) return rejected('INPUT_LIMIT', 'Invalid Claude model identifier.');
  const resumeRaw = options.nativeSessionId || options.threadId || null;
  const resumeId = typeof resumeRaw === 'string' ? resumeRaw.trim().toLowerCase() : null;
  if (resumeId && !SESSION_ID_PATTERN.test(resumeId)) return rejected('SESSION_INVALID', 'Invalid native Claude session ID.', model);
  const sessionId = (resumeId || randomUUID()).toLowerCase();
  // --restricted keeps OAuth/subscription auth (unlike --bare) and ignores user/project/local settings.
  const args = ['-p', '--restricted', '--tools', CLAUDE_READ_ONLY_TOOLS.join(','), '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model];
  const effort = options.reasoningEffort?.toLowerCase();
  if (effort && VALID_REASONING_EFFORTS.includes(effort)) args.push('--effort', effort);
  else if (effort) options.onEvent?.({ type: 'warning', message: redactDiagnostic(`Ignoring unsupported Claude reasoning effort '${effort.slice(0, 32)}'.`) });
  args.push(resumeId ? '--resume' : '--session-id', sessionId);
  const collector = createClaudeStreamCollector({ expectedSessionId: sessionId, allowedTools: CLAUDE_READ_ONLY_TOOLS, onEvent: options.onEvent });
  let channel: StdinChannel | undefined;
  const session: StdinSession = {
    start(opened, input) {
      channel = opened;
      opened.send({ type: 'user', message: { role: 'user', content: input } });
    },
    // Claude answers with a `control_response` and ends the turn with an error `result`.
    interrupt(opened) { opened.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }); },
  };
  // stdin is closed only after the terminal `result`: Claude 2.1.289 did not exit on EOF mid-turn.
  const onStdoutLine = (line: string) => {
    try { collector.line(line); }
    finally { if (collector.isTerminal()) channel?.close(); }
  };
  const result = await runCommand(claudeCommand(), args, { cwd: options.cwd, env: turnEnvironment(), stdinInput: prompt, session, abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs, maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024, onStdoutLine });
  const snapshot = collector.snapshot();
  let error = result.error || snapshot.error;
  if (!error && !snapshot.terminal) {
    error = result.status === 'completed'
      ? { code: 'PROTOCOL_ERROR', message: 'Claude Code exited without a result event.', retryable: false }
      : { code: 'PROCESS_ERROR', message: redactDiagnostic(result.stderr.trim() || `Claude Code exited with code ${result.exitCode}.`), retryable: false };
  }
  if (!error && !snapshot.initialized) {
    error = { code: 'SANDBOX_UNAVAILABLE', message: 'Claude Code completed without read-only initialization.', retryable: false };
  }
  if (!error && result.status !== 'completed') error = { code: 'PROCESS_ERROR', message: `Claude Code exited with code ${result.exitCode} after a successful result.`, retryable: false };
  const status = result.status === 'cancelled' || result.status === 'timed_out' ? result.status : error ? 'failed' : 'completed';
  const nativeSessionId = snapshot.initialized ? sessionId : null;
  const nonResumableCodes = ['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE', 'AUTH_REQUIRED', 'MODEL_UNAVAILABLE', 'POLICY_DENIED'];
  const continuationAvailable = !!nativeSessionId && (status === 'completed' || (Boolean(snapshot.hasAssistantMessage) && !nonResumableCodes.includes(error?.code || '')));
  return { status, isError: status !== 'completed', output: snapshot.output, model: snapshot.model ?? model, threadId: nativeSessionId, nativeSessionId,
    error, errorDetail: error?.message, exitCode: result.exitCode, signal: result.signal, usage: snapshot.usage,
    truncated: snapshot.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable };
}
export const execute = executeClaude;
export const claudeAdapter: CliAdapter = { id, name, probe, observeModel, listModels, execute, inspectQuota };
export default claudeAdapter;
