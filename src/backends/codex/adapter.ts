import path from 'path';
import os from 'os';
import fs from 'fs';
import { runCommand } from '../../execution/process.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  type AdapterProbeResult,
  type ExecutionOptions,
  type BackendReadContext,
  type CliAdapter,
  type TerminalExecutionResult,
} from '../types.js';
import { ToolError, validEventIdentifier, type ExecutionError } from '../../contracts/index.js';
import { isValidModelIdentifier } from '../../models/identifier.js';
import { redactDiagnostic } from '../../security/redaction.js';
import { createCodexStreamCollector } from './collector.js';
import { codexAppServerArgs, createCodexAppSession } from './app-server.js';
import { listCodexModels, readCodexRateLimits } from './models.js';
import { classifyCodexError } from './errors.js';
import { parse as parseToml } from 'smol-toml';
import { readBoundedFileSync } from '../../storage/read.js';
import { turnEnvironment } from '../../execution/nested-turn.js';
import { configuredBackendCommand, probeCommand } from '../executable.js';

export const id = 'codex';
export const name = 'OpenAI Codex CLI';
/** Codex reads `config.toml` from `CODEX_HOME` when it is set (CUR-006). */
export const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');

/** Upper bound for reading `config.toml`. */
const CODEX_CONFIG_MAX_BYTES = 256 * 1024;

/** Upper bound for a Codex prompt payload (4 MiB). */
export const CODEX_MAX_PROMPT_BYTES = 4 * 1024 * 1024;

/**
 * Upper bound for a single Codex app-server JSON-RPC line (16 MiB).
 * Accommodates prompts up to 4 MiB even with heavy escaping (e.g. 2x for newlines
 * or quotes plus framing headroom), while capping serialized JSON lines (FEEDBACK-061g).
 */
export const CODEX_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** RPC framing headroom reserved within a single line (64 KiB). */
export const CODEX_LINE_FRAMING_BYTES = 64 * 1024;

/** Maximum allowable serialized JSON string bytes for the prompt. */
export const CODEX_MAX_SERIALIZED_PROMPT_BYTES = CODEX_MAX_LINE_BYTES - CODEX_LINE_FRAMING_BYTES;

export const VALID_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface CodexConfig {
  /** Top-level `model` of `config.toml`; absent when the file names none. */
  defaultModel?: string;
  defaultReasoningEffort: string;
  sandboxMode: string;
  /** Why the configuration file could not be used; the defaults apply. */
  configError?: string;
}


/**
 * Reads the top-level `model` and `model_reasoning_effort` keys of Codex's `config.toml`.
 * Comments, tables (`[profiles.*]`) and other keys such as `review_model` are ignored.
 * @param customPath - Configuration file; defaults to `CODEX_CONFIG_PATH`.
 * @returns The configured values, or the defaults (no model) with `configError` when the file is unreadable or not valid TOML.
 */
export function readCodexConfig(customPath?: string): CodexConfig {
  const result: CodexConfig = {
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

export async function probe(context?: BackendReadContext): Promise<AdapterProbeResult> {
  const abortSignal = context?.abortSignal ?? context?.budget?.executionSignal;
  if (abortSignal?.aborted) {
    throw new ToolError('ABORTED', 'Codex probe cancelled before launch.');
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', 'Execution budget expired before probing Codex.');
  }
  const config = readCodexConfig();
  let installed = false;
  let version = 'unknown';

  const resolved = probeCommand('codex', 'OpenAI Codex CLI');
  if ('unresolved' in resolved) return resolved.unresolved;
  // runCommand reports a missing or failing CLI in its result; it does not reject.
  const res = await runCommand(resolved.command, ['--version'], {
    timeoutMs: (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0)
      ? context.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS,
    abortSignal,
  });
  if (abortSignal?.aborted || res.error?.code === 'ABORTED' || res.status === 'cancelled') {
    throw new ToolError('ABORTED', 'Codex probe cancelled.');
  }
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
    command: resolved.command,
    configPath: CODEX_CONFIG_PATH,
    config,
    // Models and their efforts come from the CLI itself (`listModels`), read on demand.
    supportedReasoningEfforts: VALID_REASONING_EFFORTS,
    executionSupported: installed,
    capabilities: { resume: true, streaming: true, readOnlyVerified: true, reasoningEffort: true },
    loginHint: 'codex',
    modelSource: 'config.toml default; models from codex app-server model/list',
    authStatus,
    authEvidence,
  };
}

export async function execute(prompt: string, options: ExecutionOptions = {}): Promise<TerminalExecutionResult> {
  const config = readCodexConfig();
  const model = options.model;
  const effort = normalizeReasoningEffort(options.reasoningEffort, config.defaultReasoningEffort);
  const requestedThread = options.nativeSessionId || options.threadId || null;
  const rejected = (code: ExecutionError['code'], message: string): TerminalExecutionResult => ({
    status: 'failed', isError: true, output: '', model, error: { code, message, retryable: false }, truncated: false, continuationAvailable: false,
  });
  if (model === undefined) return rejected('INPUT_LIMIT', 'No Codex model selected; the controller passes the config.toml model or the catalog default.');
  if (!isValidModelIdentifier(model)) return rejected('INPUT_LIMIT', 'Invalid Codex model identifier.');
  if (requestedThread && (!validEventIdentifier(requestedThread) || requestedThread.startsWith('-'))) return rejected('SESSION_INVALID', 'Invalid native Codex session ID.');
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > CODEX_MAX_PROMPT_BYTES) {
    return rejected('INPUT_LIMIT', `Prompt exceeds the UTF-8 byte limit (${promptBytes} > ${CODEX_MAX_PROMPT_BYTES} bytes).`);
  }
  const serializedPromptBytes = Buffer.byteLength(JSON.stringify(prompt), 'utf8');
  if (serializedPromptBytes > CODEX_MAX_SERIALIZED_PROMPT_BYTES) {
    return rejected('INPUT_LIMIT', `Serialized prompt exceeds the line record limit (${serializedPromptBytes} > ${CODEX_MAX_SERIALIZED_PROMPT_BYTES} bytes).`);
  }
  // The app-server session requests read-only mode per thread and verifies the server's
  // answer; the config overrides pin the same policy for the server's defaults and turn off
  // the features that add tools beyond the read-only shell.
  const args = codexAppServerArgs();
  const collector = createCodexStreamCollector({ nativeSessionId: requestedThread, onEvent: options.onEvent });
  const app = createCodexAppSession({ collector, threadId: requestedThread, model, effort,
    cwd: path.resolve(options.cwd || process.cwd()), onEvent: options.onEvent });
  const result = await runCommand(configuredBackendCommand('codex'), args, {
    cwd: options.cwd, env: turnEnvironment(), stdinInput: prompt, session: app.session, abortSignal: options.abortSignal, timeoutMs: options.timeoutMs,
    maxBufferBytes: 512 * 1024, maxLineBytes: CODEX_MAX_LINE_BYTES, maxInputBytes: CODEX_MAX_PROMPT_BYTES, onStdoutLine: app.line,
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
  // The answer is the collector's; the runner's bounded stdout copy of the protocol stream
  // (tool output, deltas) is diagnostic, and filling it does not cut the answer.
  return { status, isError: status !== 'completed', output: snapshot.output, model: app.resolvedModel() ?? model,
    threadId, nativeSessionId: threadId, error, errorDetail: error?.message, exitCode: result.exitCode, signal: result.signal,
    usage, truncated: snapshot.truncated || error?.code === 'BUFFER_LIMIT',
    continuationAvailable: initialized && !!threadId && !['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(error?.code || ''),
    denials: snapshot.denials };
}

export const codexAdapter: CliAdapter = {
  id,
  name,
  probe,
  execute,
  listModels: (_probe?: AdapterProbeResult, context?: BackendReadContext) =>
    listCodexModels(configuredBackendCommand('codex'), VALID_REASONING_EFFORTS, context),
  // ChatGPT sign-in limits from app-server; an API-key account has none and stays unmeasured.
  inspectQuota: (_probe?: AdapterProbeResult, context?: BackendReadContext) =>
    readCodexRateLimits(configuredBackendCommand('codex'), context),
};

export default codexAdapter;
