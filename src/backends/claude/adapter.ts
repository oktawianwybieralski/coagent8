import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runCommand, type StdinChannel, type StdinSession } from '../../execution/process.js';
import { redactDiagnostic } from '../../redaction.js';
import { isValidModelIdentifier } from '../model-identifier.js';
import { createClaudeStreamCollector } from './collector.js';
import { parseClaudeUsage } from './usage.js';
import type { AdapterProbeResult, ExecutionOptions, TerminalExecutionResult, CliAdapter } from '../types.js';
import type { ExecutionError } from '../../conversation.js';
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

/**
 * Reads installation, version and local login state without calling a model.
 * @remarks `claude auth status` reports the CLI's own login state (exit 0 when
 * logged in, 1 when not). Token validity is proven only by an execution.
 * Read-only enforcement is checked on every run against `system/init`.
 */
export async function probe(): Promise<AdapterProbeResult> {
  const resolved = probeCommand('claude', name);
  if ('unresolved' in resolved) return resolved.unresolved;
  const command = resolved.command;
  const res = await runCommand(command, ['--version'], { timeoutMs: 5000 });
  const installed = res.status === 'completed';
  const version = res.stdout.trim() || 'unknown';
  const executionSupported = installed && supportsClaudeVersion(version);
  let authStatus = 'unknown', authMethod: string | undefined;
  const authEvidence: string[] = [];
  if (installed) {
    const auth = await runCommand(command, ['auth', 'status', '--json'], { timeoutMs: 10000 });
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
    modelSource: 'any Claude Code model or alias; the CLI reports the concrete model in system/init', executionSupported,
    capabilities: { resume: true, streaming: true, readOnlyVerified: executionSupported, reasoningEffort: true } };
}

/**
 * Runs `claude -p /usage`, a local command, in the restricted profile with stream-json output.
 * @param model - The `--model` to pass; omitted for the model Claude Code runs without one.
 * @param probe - Probe result whose version is checked; `--version` runs when it has none.
 * @returns The model `system/init` reports and the usage text, or undefined when the CLI is
 * older than {@link MIN_CLAUDE_VERSION}, fails, or reports any model turn or cost.
 * @remarks Nothing reaches a model on a verified version; a turn or cost a later version
 * might report discards the run.
 */
async function runLocalUsage(model: string | undefined, probe?: AdapterProbeResult): Promise<{ model?: string; usage: string } | undefined> {
  let version = probe?.version;
  if (!version || version === 'unknown') {
    const verRes = await runCommand(claudeCommand(), ['--version'], { timeoutMs: 5000 });
    if (verRes.status !== 'completed') return undefined;
    version = verRes.stdout.trim();
  }
  if (!supportsClaudeVersion(version)) return undefined;
  const res = await runCommand(claudeCommand(), ['-p', '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    ...(model ? ['--model', model] : []), '--output-format', 'stream-json', '--verbose', '/usage'], { timeoutMs: 15000 });
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
 * @returns Measured quota, or `undefined` when the CLI is older than the verified version,
 * the run reports a model turn or cost, or it prints no limits (API-key billing).
 */
export async function inspectQuota(probe?: AdapterProbeResult): Promise<AdapterProbeResult['quota']> {
  const run = await runLocalUsage(undefined, probe);
  return run ? parseClaudeUsage(run.usage) : undefined;
}

/**
 * Asks Claude Code which concrete model it runs for a name or alias, or without one (its
 * account default, as the restricted profile sees it), from `system/init` of a local
 * `/usage` run: no model turn and no cost.
 * @param requested - The model or alias; omitted for the default.
 * @param probe - Probe result whose version is checked.
 */
export async function observeModel(requested?: string, probe?: AdapterProbeResult): Promise<string | undefined> {
  if (requested !== undefined && !isValidModelIdentifier(requested)) return undefined;
  return (await runLocalUsage(requested, probe))?.model;
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
export const claudeAdapter: CliAdapter = { id, name, probe, observeModel, execute, inspectQuota };
export default claudeAdapter;
