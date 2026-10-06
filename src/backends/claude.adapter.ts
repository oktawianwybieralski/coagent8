import { randomUUID } from 'node:crypto';
import { runCommand } from '../execution/process.js';
import { redactDiagnostic } from '../redaction.js';
import { checkModelGovernance } from './policy.js';
import { createClaudeStreamCollector } from './claude.collector.js';
import { parseClaudeUsage } from './claude-usage.js';
import type { AdapterProbeResult, ExecutionOptions, TerminalExecutionResult, CliAdapter, ExecutionError } from '../types/adapter.types.js';
export const id = 'claude', name = 'Claude Code CLI';
export const CLAUDE_EXE = process.env.CLAUDE_PATH || 'claude';
/** Built-in tools of the read-only profile; `--restricted` removes every code-running tool not named here. */
export const CLAUDE_READ_ONLY_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** `--restricted` needs 2.1.248 and `--permission-prompts` 2.1.259 (Claude Code CLI reference). */
export const MIN_CLAUDE_VERSION: readonly [number, number, number] = [2, 1, 259];
/** Local /usage execution in print mode was verified live on 2.1.289; versions older than 2.1.289 skip /usage; a reported model turn or cost is discarded. */
export const MIN_CLAUDE_USAGE_VERSION: readonly [number, number, number] = [2, 1, 289];
/** Model identifier pattern from the audit (AUD-P1-6); rejects option-like and whitespace values. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
const SESSION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const claudeCommand = () => process.env.CLAUDE_PATH || CLAUDE_EXE;

export function resolveClaudeModel(requested = 'sonnet'): string {
  if (requested === 'default') throw Object.assign(new Error('Claude model=default has unknown cost; choose an explicit model or sonnet/haiku alias.'), { code: 'POLICY_DENIED' });
  const match = /^(sonnet|haiku|opus)(\[1m\])?$/.exec(requested);
  const override = match && process.env[`ANTHROPIC_DEFAULT_${match[1].toUpperCase()}_MODEL`];
  return override ? override + (match![2] || '') : requested;
}

export function supportsVersion(versionOutput: string, min: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionOutput.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (actual[i] !== min[i]) return actual[i] > min[i];
  return true;
}

/** Returns whether a `claude --version` output meets {@link MIN_CLAUDE_VERSION}. */
export function supportsRestrictedMode(versionOutput: string): boolean {
  return supportsVersion(versionOutput, MIN_CLAUDE_VERSION);
}

/** Returns whether a `claude --version` output meets {@link MIN_CLAUDE_USAGE_VERSION}. */
export function supportsLocalUsage(versionOutput: string): boolean {
  return supportsVersion(versionOutput, MIN_CLAUDE_USAGE_VERSION);
}

/**
 * Reads installation, version and local login state without calling a model.
 * @remarks `claude auth status` reports the CLI's own login state (exit 0 when
 * logged in, 1 when not). Token validity is proven only by an execution.
 * Read-only enforcement is checked on every run against `system/init`.
 */
export async function probe(): Promise<AdapterProbeResult> {
  const command = claudeCommand();
  const res = await runCommand(command, ['--version'], { timeoutMs: 5000 });
  const installed = res.status === 'completed';
  const version = res.stdout.trim() || 'unknown';
  const executionSupported = installed && supportsRestrictedMode(version);
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
  if (installed && !executionSupported) authEvidence.push(`Claude Code ${version} predates --restricted/--permission-prompts (requires ${MIN_CLAUDE_VERSION.join('.')}).`);
  return { id, name, installed, version, command, authStatus, authMethod, authEvidence, loginHint: 'claude auth login',
    availableModels: [], supportedReasoningEfforts: VALID_REASONING_EFFORTS, config: { defaultModel: resolveClaudeModel() },
    modelSource: 'Bridge explicitly pins sonnet or its environment alias override; account availability not probed', executionSupported,
    capabilities: { resume: true, streaming: true, readOnlyVerified: executionSupported, reasoningEffort: true } };
}

/**
 * Reads subscription limits from `claude -p /usage`, a local command that makes no model call.
 * @param probe - Optional probe result with pre-collected version to avoid re-invoking `--version`.
 * @returns Measured quota, or `undefined` when the CLI version is not verified to run
 * `/usage` locally (predates 2.1.289), prints no limits (API-key billing), fails,
 * or reports any model turn or cost.
 * @remarks `/usage` is passed as the argument. `--model haiku` bounds the cost should an
 * unverified CLI version forward it to a model; a governed alias override skips the read.
 */
export async function inspectQuota(probe?: AdapterProbeResult): Promise<AdapterProbeResult['quota']> {
  let version = probe?.version;
  if (!version || version === 'unknown') {
    const verRes = await runCommand(claudeCommand(), ['--version'], { timeoutMs: 5000 });
    if (verRes.status !== 'completed') return undefined;
    version = verRes.stdout.trim();
  }
  if (!supportsLocalUsage(version)) return undefined;
  const model = resolveClaudeModel('haiku');
  if (!MODEL_ID_PATTERN.test(model) || checkModelGovernance(model, false)) return undefined;
  const res = await runCommand(claudeCommand(), ['-p', '--restricted', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence',
    '--model', model, '--output-format', 'json', '/usage'], { timeoutMs: 15000 });
  if (res.status !== 'completed') return undefined;
  let result: Record<string, unknown>;
  try { result = JSON.parse(res.stdout) as Record<string, unknown>; }
  catch { return undefined; }
  if (result?.is_error !== false || result.local_command !== 'usage' || result.num_turns !== 0 || result.total_cost_usd !== 0 || typeof result.result !== 'string') return undefined;
  return parseClaudeUsage(result.result);
}

/**
 * Runs one Claude Code turn in restricted, read-only print mode.
 * @remarks Subscription (OAuth) and API-key authentication both work. Each run
 * fails closed with `SANDBOX_UNAVAILABLE` unless `system/init` reports only
 * {@link CLAUDE_READ_ONLY_TOOLS}, no MCP server and `dontAsk`. A new turn
 * pins a fresh `--session-id`; a continuation passes `--resume`.
 */
export async function executeClaude(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  const rejected = (code: ExecutionError['code'], message: string, model?: string): TerminalExecutionResult => ({
    status: 'failed', isError: true, output: '', model, error: { code, message: redactDiagnostic(message), retryable: false }, errorDetail: redactDiagnostic(message), truncated: false, continuationAvailable: false,
  });
  const requested: unknown = options.model ?? undefined;
  if (requested !== undefined && (typeof requested !== 'string' || !MODEL_ID_PATTERN.test(requested))) return rejected('POLICY_DENIED', 'Invalid Claude model identifier.');
  let model: string;
  try { model = resolveClaudeModel(requested); }
  catch (err) { return rejected('POLICY_DENIED', (err as Error).message); }
  if (!MODEL_ID_PATTERN.test(model)) return rejected('POLICY_DENIED', 'Invalid Claude model identifier from the environment alias override.');
  if (checkModelGovernance(model, options.userConfirmed)) return rejected('POLICY_DENIED', 'Top-tier model requires explicit consent.', model);
  const resumeRaw = options.nativeSessionId || options.threadId || null;
  const resumeId = typeof resumeRaw === 'string' ? resumeRaw.trim().toLowerCase() : null;
  if (resumeId && !SESSION_ID_PATTERN.test(resumeId)) return rejected('SESSION_INVALID', 'Invalid native Claude session ID.', model);
  const sessionId = (resumeId || randomUUID()).toLowerCase();
  // --restricted keeps OAuth/subscription auth (unlike --bare) and ignores user/project/local settings.
  const args = ['-p', '--restricted', '--tools', CLAUDE_READ_ONLY_TOOLS.join(','), '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model];
  const effort = options.reasoningEffort?.toLowerCase();
  if (effort && VALID_REASONING_EFFORTS.includes(effort)) args.push('--effort', effort);
  else if (effort) options.onEvent?.({ type: 'warning', message: redactDiagnostic(`Ignoring unsupported Claude reasoning effort '${effort.slice(0, 32)}'.`) });
  args.push(resumeId ? '--resume' : '--session-id', sessionId);
  const collector = createClaudeStreamCollector({ expectedSessionId: sessionId, allowedTools: CLAUDE_READ_ONLY_TOOLS, onEvent: options.onEvent });
  const result = await runCommand(claudeCommand(), args, { cwd: options.cwd, stdinInput: prompt, abortSignal: options.abortSignal,
    timeoutMs: options.timeoutMs, maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024, onStdoutLine: collector.line });
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
  return { status, isError: status !== 'completed', output: snapshot.output, model, threadId: nativeSessionId, nativeSessionId,
    error, errorDetail: error?.message, exitCode: result.exitCode, signal: result.signal, usage: snapshot.usage,
    truncated: snapshot.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable };
}
export const execute = executeClaude;
export const claudeAdapter: CliAdapter = { id, name, probe, execute, inspectQuota };
export default claudeAdapter;
