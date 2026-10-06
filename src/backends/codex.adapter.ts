import path from 'path';
import os from 'os';
import fs from 'fs';
import { runCommand } from '../execution/process.js';
import type { AdapterProbeResult, ExecutionOptions, CliAdapter, TerminalExecutionResult, ExecutionError } from '../types/adapter.types.js';
import { validEventIdentifier } from '../types/conversation.types.js';
import { checkModelGovernance } from './policy.js';
import { redactDiagnostic, redactSecrets } from '../redaction.js';
import { createCodexStreamCollector } from './codex.collector.js';
import { classifyCodexError } from './codex-errors.js';

export const id = 'codex';
export const name = 'OpenAI Codex CLI';
export const CODEX_EXE = process.env.CODEX_PATH || 'codex';
export const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(os.homedir(), '.codex', 'config.toml');

export const VALID_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface CodexConfig {
  defaultModel: string;
  defaultReasoningEffort: string;
  sandboxMode: string;
}

export function resolveCodexCommand(): { command: string; argsPrefix: string[] } {
  if (process.env.CODEX_PATH) {
    return { command: process.env.CODEX_PATH, argsPrefix: [] };
  }
  return { command: CODEX_EXE, argsPrefix: [] };
}

export const CODEX_CMD = resolveCodexCommand();

export function readCodexConfig(customPath?: string): CodexConfig {
  const result: CodexConfig = {
    defaultModel: 'gpt-6.1-sol',
    defaultReasoningEffort: 'low',
    sandboxMode: 'read-only',
  };

  const targetPath = customPath || process.env.CODEX_CONFIG_PATH || CODEX_CONFIG_PATH;
  try {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf-8');
      const modelMatch = content.match(/model\s*=\s*["']([^"']+)["']/);
      if (modelMatch) result.defaultModel = modelMatch[1];

      const effortMatch = content.match(/model_reasoning_effort\s*=\s*["']([^"']+)["']/);
      if (effortMatch && VALID_REASONING_EFFORTS.includes(effortMatch[1])) {
        result.defaultReasoningEffort = effortMatch[1];
      }
    }
  } catch (_) {}

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

  try {
    const res = await runCommand(CODEX_CMD.command, [...CODEX_CMD.argsPrefix, '--version'], { timeoutMs: 5000 });
    if (res.exitCode === 0) {
      installed = true;
      version = res.stdout.trim() || 'installed';
    }
  } catch (_) {}

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

export { truncateToByteLength } from '../execution/stream-reducer.js';

export { createCodexStreamCollector } from './codex.collector.js';
export { classifyCodexError, extractStructuredCodexError } from './codex-errors.js';

export async function execute(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  const config = readCodexConfig();
  const model = options.model || config.defaultModel;
  const effort = normalizeReasoningEffort(options.reasoningEffort, config.defaultReasoningEffort);
  const requestedThread = options.nativeSessionId || options.threadId || null;
  const rejected = (code: ExecutionError['code'], message: string): TerminalExecutionResult => ({
    status: 'failed', isError: true, output: '', model, error: { code, message, retryable: false }, truncated: false, continuationAvailable: false,
  });
  if (checkModelGovernance(model, options.userConfirmed)) return rejected('POLICY_DENIED', 'Effective Codex model requires explicit confirmation.');
  if (requestedThread && (!validEventIdentifier(requestedThread) || requestedThread.startsWith('-'))) return rejected('SESSION_INVALID', 'Invalid native Codex session ID.');
  // Exec-level sandbox is placed before resume; resume has no --sandbox flag.
  // Pin the config too so a resumed thread cannot inherit a writable profile.
  const args = ['exec', '--sandbox', 'read-only', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
  if (requestedThread) args.push('resume', requestedThread);
  args.push('--skip-git-repo-check', '--json', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-');
  const collector = createCodexStreamCollector({ nativeSessionId: requestedThread, onEvent: options.onEvent });
  const result = await runCommand(process.env.CODEX_PATH || CODEX_EXE, args, {
    cwd: options.cwd, stdinInput: prompt, abortSignal: options.abortSignal, timeoutMs: options.timeoutMs,
    maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024, onStdoutLine: collector.line,
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
  const status = result.status === 'cancelled' || result.status === 'timed_out' ? result.status : error ? 'failed' : 'completed';
  return { status, isError: status !== 'completed', output: snapshot.output, model,
    threadId, nativeSessionId: threadId, error, errorDetail: error?.message, exitCode: result.exitCode, signal: result.signal,
    usage, truncated: result.isTruncated || snapshot.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable: initialized && !!threadId && !['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(error?.code || '') };
}

export const codexAdapter: CliAdapter = {
  id,
  name,
  probe,
  execute,
};

export default codexAdapter;
