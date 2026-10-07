import path from 'path';
import os from 'os';
import fs from 'fs';
import { runCommand } from '../../execution/process.js';
import type { AdapterProbeResult, ExecutionOptions, CliAdapter, TerminalExecutionResult } from '../types.js';
import { validEventIdentifier, type ExecutionError } from '../../conversation.js';
import { consentRequiredMessage, isGovernedModel, isValidModelIdentifier } from '../governance.js';
import { redactDiagnostic } from '../../redaction.js';
import { createCodexStreamCollector } from './collector.js';
import { createCodexAppSession } from './app-server.js';
import { classifyCodexError } from './errors.js';
import { parse as parseToml } from 'smol-toml';
import { readBoundedFileSync } from '../../execution/stream.js';

export const id = 'codex';
export const name = 'OpenAI Codex CLI';
const CODEX_EXE = process.env.CODEX_PATH || 'codex';
export const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');

/** Upper bound for reading `config.toml`. */
const CODEX_CONFIG_MAX_BYTES = 256 * 1024;

export const VALID_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface CodexConfig {
  defaultModel: string;
  defaultReasoningEffort: string;
  sandboxMode: string;
  /** Why the configuration file could not be used; the defaults apply. */
  configError?: string;
}

const CODEX_CMD: { command: string; argsPrefix: string[] } = { command: CODEX_EXE, argsPrefix: [] };

/**
 * Reads the top-level `model` and `model_reasoning_effort` keys of Codex's `config.toml`.
 * Comments, tables (`[profiles.*]`) and other keys such as `review_model` are ignored.
 * @param customPath - Configuration file; defaults to `CODEX_CONFIG_PATH`.
 * @returns The configured values, or the defaults with `configError` when the file is unreadable or not valid TOML.
 */
export function readCodexConfig(customPath?: string): CodexConfig {
  const result: CodexConfig = {
    defaultModel: 'gpt-6.1-sol',
    defaultReasoningEffort: 'low',
    sandboxMode: 'read-only',
  };

  const targetPath = customPath || process.env.CODEX_CONFIG_PATH || CODEX_CONFIG_PATH;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readBoundedFileSync(targetPath, CODEX_CONFIG_MAX_BYTES));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
    return { ...result, configError: `Codex configuration not used: ${redactDiagnostic((err as Error).message, 256)}` };
  }
  if (typeof parsed.model === 'string' && parsed.model.trim()) result.defaultModel = parsed.model.trim();
  const effort = parsed.model_reasoning_effort;
  if (typeof effort === 'string' && VALID_REASONING_EFFORTS.includes(effort)) result.defaultReasoningEffort = effort;
  return result;
}

export function normalizeReasoningEffort(effort?: string | null, defaultEffort = 'low'): string {
  if (typeof effort === 'string' && VALID_REASONING_EFFORTS.includes(effort.toLowerCase())) {
    return effort.toLowerCase();
  }
  return defaultEffort;
}

export async function probe(): Promise<AdapterProbeResult> {
  const config = readCodexConfig();
  let installed = false;
  let version = 'unknown';

  // runCommand reports a missing or failing CLI in its result; it does not reject.
  const res = await runCommand(CODEX_CMD.command, [...CODEX_CMD.argsPrefix, '--version'], { timeoutMs: 5000 });
  if (res.exitCode === 0) {
    installed = true;
    version = res.stdout.trim() || 'installed';
  }

  const authEvidence: string[] = [];
  const codexDir = path.dirname(CODEX_CONFIG_PATH);
  const authPath = path.join(codexDir, 'auth.json');
  const homeAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
  const targetAuth = fs.existsSync(authPath) ? authPath : (authPath !== homeAuthPath && fs.existsSync(homeAuthPath)) ? homeAuthPath : null;
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
  const hasConfigFile = fs.existsSync(CODEX_CONFIG_PATH);

  let authStatus = 'unknown';

  if (hasApiKey) {
    authEvidence.push('API key present');
    authStatus = 'authenticated';
  }
  if (targetAuth) {
    try {
      const parsed = JSON.parse(fs.readFileSync(targetAuth, 'utf-8'));
      if (parsed.tokens || parsed.OPENAI_API_KEY) {
        authEvidence.push(`Auth credentials present (${parsed.auth_mode || 'chatgpt'})`);
        authStatus = 'authenticated';
      } else {
        authEvidence.push('Auth file present (no tokens)');
        authStatus = 'unauthenticated';
      }
    } catch (_) {
      authEvidence.push('Auth file present (not verified)');
    }
  } else if (!hasApiKey) {
    authStatus = 'unauthenticated';
  }
  if (hasConfigFile) {
    authEvidence.push('Config present');
  }
  if (authEvidence.length === 0) {
    authEvidence.push('No local evidence');
  }

  return {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    installed,
    version,
    command: CODEX_CMD.command,
    configPath: CODEX_CONFIG_PATH,
    config,
    availableModels: ['gpt-6.1-sol', 'gpt-6.0-sol', 'luna', 'astra'],
    supportedReasoningEfforts: VALID_REASONING_EFFORTS,
    executionSupported: installed,
    capabilities: { resume: true, streaming: true, readOnlyVerified: true, reasoningEffort: true },
    loginHint: 'codex',
    modelSource: 'config.toml and built-in model definitions',
    authStatus,
    authEvidence,
  };
}

/** Returns the requested model, or the `config.toml` default that `execute` runs without one. */
export function resolveModel(requested?: string): string {
  return requested || readCodexConfig().defaultModel;
}

export async function execute(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  const config = readCodexConfig();
  const model = options.model || config.defaultModel;
  const effort = normalizeReasoningEffort(options.reasoningEffort, config.defaultReasoningEffort);
  const requestedThread = options.nativeSessionId || options.threadId || null;
  const rejected = (code: ExecutionError['code'], message: string): TerminalExecutionResult => ({
    status: 'failed', isError: true, output: '', model, error: { code, message, retryable: false }, truncated: false, continuationAvailable: false,
  });
  if (!isValidModelIdentifier(model)) return rejected('INPUT_LIMIT', 'Invalid Codex model identifier.');
  if (isGovernedModel(model) && options.consentedModel !== model) return rejected('POLICY_DENIED', consentRequiredMessage(model));
  if (requestedThread && (!validEventIdentifier(requestedThread) || requestedThread.startsWith('-'))) return rejected('SESSION_INVALID', 'Invalid native Codex session ID.');
  // The app-server session requests read-only mode per thread and verifies the server's
  // answer; the config overrides pin the same policy for the server's defaults.
  const args = ['app-server', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  const collector = createCodexStreamCollector({ nativeSessionId: requestedThread, onEvent: options.onEvent });
  const app = createCodexAppSession({ collector, threadId: requestedThread, model, effort,
    cwd: path.resolve(options.cwd || process.cwd()), onEvent: options.onEvent });
  const result = await runCommand(process.env.CODEX_PATH || CODEX_EXE, args, {
    cwd: options.cwd, stdinInput: prompt, session: app.session, abortSignal: options.abortSignal, timeoutMs: options.timeoutMs,
    maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024, onStdoutLine: app.line,
  });
  const snapshot = collector.snapshot();
  const { initialized, terminal, threadId, usage } = snapshot;
  let error = result.error || snapshot.error;
  if (!error && result.status !== 'completed') {
    const fallbackStderr = result.stderr ? result.stderr.trim() : '';
    error = fallbackStderr
      ? classifyCodexError(fallbackStderr)
      : { code: 'PROCESS_ERROR', message: `Codex exited with code ${result.exitCode}.`, retryable: false };
  }
  if (!error && (!initialized || !terminal)) error = { code: 'PROTOCOL_ERROR', message: 'Codex exited without a thread and terminal event.', retryable: false };
  if (!error && snapshot.interrupted) error = { code: 'PROCESS_ERROR', message: 'Codex interrupted the turn.', retryable: false };
  const status = result.status === 'cancelled' || result.status === 'timed_out' ? result.status : error ? 'failed' : 'completed';
  return { status, isError: status !== 'completed', output: snapshot.output, model: app.resolvedModel() ?? model,
    threadId, nativeSessionId: threadId, error, errorDetail: error?.message, exitCode: result.exitCode, signal: result.signal,
    usage, truncated: result.isTruncated || snapshot.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable: initialized && !!threadId && !['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(error?.code || '') };
}

export const codexAdapter: CliAdapter = {
  id,
  name,
  probe,
  resolveModel,
  execute,
};

export default codexAdapter;
