/**
 * One read-only turn over the `codex app-server` JSON-RPC protocol (Codex CLI 0.160; the isolation checks need 0.162).
 *
 * @remarks
 * Messages are newline-delimited JSON-RPC 2.0 without the `jsonrpc` field. The session
 * performs the `initialize`/`initialized` handshake, starts or resumes the thread, fails
 * closed unless the server reports a read-only sandbox with `approvalPolicy: "never"`,
 * starts one turn and closes stdin when the turn completes, which ends the server. An
 * interrupt sends `turn/interrupt`; the server then completes the turn with
 * `status: "interrupted"`. Server-initiated requests (approvals, user input, tool calls)
 * are answered with a JSON-RPC error: this client never grants anything.
 *
 * Inherited tools are removed before the turn (`CUR-002`). The server starts with the
 * features in {@link CODEX_DISABLED_FEATURES} turned off; the thread starts with every
 * MCP server of the effective configuration (`config/read` for the turn's directory,
 * project layers included) disabled. An empty `mcp_servers` table cannot do this, because
 * Codex merges configuration layers. The turn starts only after the server reports, for
 * that thread, each of those features off and every MCP server, plugin servers included,
 * `disabled`.
 *
 * @packageDocumentation
 */
import { BRAND } from '../../constants.js';
import { ToolError, validEventIdentifier, type AdapterEvent, type ExecutionError } from '../../conversation.js';
import type { StdinChannel, StdinSession } from '../../execution/process.js';
import { classifyCodexTurnError } from './errors.js';
import type { createCodexStreamCollector } from './collector.js';
import { isValidModelIdentifier } from '../model-identifier.js';

/**
 * Codex features that give a turn tools or commands beyond the read-only shell: connectors
 * and plugins, browser and computer control, MCP installation for skills, tool suggestions,
 * user hooks and subagents (whose threads this client cannot inspect). Codex 0.162 enables
 * all but `multi_agent_v2` by default and ignores names it does not know.
 */
export const CODEX_DISABLED_FEATURES = [
  'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'skill_mcp_dependency_install', 'tool_suggest', 'hooks', 'multi_agent', 'multi_agent_v2',
] as const;

/**
 * Arguments of every `codex app-server` launch: read-only sandbox, no approvals and the
 * features in {@link CODEX_DISABLED_FEATURES} off.
 */
export function codexAppServerArgs(): string[] {
  return ['app-server', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
    ...CODEX_DISABLED_FEATURES.flatMap(feature => ['-c', `features.${feature}=false`])];
}

/** Pages read at most from a paginated isolation check before it fails closed. */
const MAX_CHECK_PAGES = 20;

export interface CodexAppSessionOptions {
  collector: ReturnType<typeof createCodexStreamCollector>;
  /** Thread to resume; a new thread is started when absent. */
  threadId?: string | null;
  model: string;
  effort: string;
  cwd: string;
  onEvent?: (event: AdapterEvent) => void;
}

const REQUEST = { initialize: 1, thread: 2, turn: 3, interrupt: 4, config: 5, features: 6, mcpStatus: 7 } as const;
/** Requests whose failure means the server cannot show that the turn runs without inherited tools. */
const ISOLATION_REQUESTS: readonly unknown[] = [REQUEST.config, REQUEST.features, REQUEST.mcpStatus];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function typed(code: ExecutionError['code'], message: string): ToolError {
  return new ToolError(code, message);
}
function isolationFailure(detail: string): ToolError {
  return typed('SANDBOX_UNAVAILABLE', `Codex did not confirm a turn without inherited MCP servers or plugins: ${detail}`);
}

/**
 * Names of the MCP servers in a `config/read` result.
 * @throws `SANDBOX_UNAVAILABLE` when the result has no configuration or `mcp_servers` is not a table.
 */
export function configuredCodexMcpServers(result: unknown): string[] {
  const config = record(record(result)?.config);
  if (!config) throw isolationFailure('config/read returned no configuration.');
  if (config.mcp_servers === undefined || config.mcp_servers === null) return [];
  const servers = record(config.mcp_servers);
  if (!servers) throw isolationFailure('mcp_servers is not a table.');
  return Object.keys(servers);
}

/**
 * Checks one `experimentalFeature/list` page of the thread.
 * @returns The cursor of the next page, or null after the last one.
 * @throws `SANDBOX_UNAVAILABLE` when a feature of {@link CODEX_DISABLED_FEATURES} is enabled.
 */
export function checkCodexFeaturePage(result: unknown): string | null {
  const page = record(result);
  if (!page || !Array.isArray(page.data)) throw isolationFailure('experimentalFeature/list returned no features.');
  for (const entry of page.data) {
    const feature = record(entry);
    if (typeof feature?.name !== 'string') throw isolationFailure('experimentalFeature/list returned a feature without a name.');
    if ((CODEX_DISABLED_FEATURES as readonly string[]).includes(feature.name) && feature.enabled !== false) {
      throw isolationFailure(`feature '${feature.name}' is still enabled.`);
    }
  }
  return typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
}

/**
 * Checks one `mcpServerStatus/list` page of the thread: every server must be `disabled`
 * and offer no tools.
 * @returns The cursor of the next page, or null after the last one.
 * @throws `SANDBOX_UNAVAILABLE` naming the first server that is not disabled.
 */
export function checkCodexMcpStatusPage(result: unknown): string | null {
  const page = record(result);
  if (!page || !Array.isArray(page.data)) throw isolationFailure('mcpServerStatus/list returned no servers.');
  for (const entry of page.data) {
    const server = record(entry);
    const name = typeof server?.name === 'string' ? server.name.slice(0, 64) : '(unnamed)';
    const tools = record(server?.tools);
    if (server?.runtimeStatus !== 'disabled' || (tools && Object.keys(tools).length)) {
      throw isolationFailure(`MCP server '${name}' is not disabled.`);
    }
  }
  return typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
}

/**
 * Creates the stdin session and stdout line handler for one Codex app-server turn.
 * @param options - Collector, thread, model, effort and working directory of the turn.
 * @returns `session` for `runCommand` and `line` for its `onStdoutLine`.
 * @throws From `line`: `SANDBOX_UNAVAILABLE` when the server does not confirm read-only
 * mode, `SESSION_INVALID` for an unknown thread, `PROTOCOL_ERROR` on malformed messages,
 * and typed provider errors for failed requests.
 */
export function createCodexAppSession(options: CodexAppSessionOptions) {
  const { collector } = options;
  let channel: StdinChannel | undefined;
  let prompt = '';
  let interruptRequested = false, interruptSent = false;
  let warnedRequest = false;
  let resolvedModel: string | undefined;
  let threadId: string | undefined;
  let checkPages = 0;

  const send = (message: Record<string, unknown>) => channel?.send(message);
  // Every failure ends the server: no turn is left running after the run stops.
  const fail = (error: Error): never => { channel?.close(); throw error; };
  // An isolation check that throws ends the server like any other failure.
  const checked = <T>(check: () => T): T => { try { return check(); } catch (err) { return fail(err as Error); } };
  function sendInterrupt() {
    const { threadId, turnId } = collector.snapshot();
    if (interruptSent || !threadId || !turnId) return;
    interruptSent = true;
    send({ id: REQUEST.interrupt, method: 'turn/interrupt', params: { threadId, turnId } });
  }

  function onInitialized() {
    send({ method: 'initialized' });
    // The effective configuration for the turn's directory names every inherited MCP server.
    send({ id: REQUEST.config, method: 'config/read', params: { cwd: options.cwd } });
  }
  function onConfig(result: unknown) {
    const servers = checked(() => configuredCodexMcpServers(result));
    const thread: Record<string, unknown> = { model: options.model, cwd: options.cwd, approvalPolicy: 'never', sandbox: 'read-only' };
    if (servers.length) thread.config = { mcp_servers: Object.fromEntries(servers.map(name => [name, { enabled: false }])) };
    send(options.threadId
      // `excludeTurns` keeps the response from carrying the whole thread history.
      ? { id: REQUEST.thread, method: 'thread/resume', params: { ...thread, threadId: options.threadId, excludeTurns: true } }
      : { id: REQUEST.thread, method: 'thread/start', params: thread });
  }
  function requestPage(id: typeof REQUEST.features | typeof REQUEST.mcpStatus, cursor: string | null) {
    if (++checkPages > MAX_CHECK_PAGES) fail(isolationFailure('too many result pages.'));
    const params: Record<string, unknown> = { threadId, ...(cursor ? { cursor } : {}) };
    if (id === REQUEST.features) send({ id, method: 'experimentalFeature/list', params });
    else send({ id, method: 'mcpServerStatus/list', params: { ...params, detail: 'toolsAndAuthOnly' } });
  }
  function onThread(result: Record<string, unknown>) {
    const sandbox = record(result.sandbox);
    if (sandbox?.type !== 'readOnly' || result.approvalPolicy !== 'never') {
      fail(typed('SANDBOX_UNAVAILABLE', 'Codex did not confirm a read-only sandbox with approvals disabled.'));
    }
    const id = record(result.thread)?.id;
    if (typeof id !== 'string') fail(typed('PROTOCOL_ERROR', 'Codex returned a thread without an ID.'));
    // The thread reports the model chosen from the request or the Codex configuration.
    if (isValidModelIdentifier(result.model)) resolvedModel = result.model;
    threadId = id as string;
    requestPage(REQUEST.features, null);
  }
  function onFeatures(result: unknown) {
    const next = checked(() => checkCodexFeaturePage(result));
    requestPage(next ? REQUEST.features : REQUEST.mcpStatus, next);
  }
  function onMcpStatus(result: unknown) {
    const next = checked(() => checkCodexMcpStatusPage(result));
    if (next) { requestPage(REQUEST.mcpStatus, next); return; }
    collector.initialize(threadId as string);
    send({ id: REQUEST.turn, method: 'turn/start', params: {
      threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], effort: options.effort } });
  }
  function onTurn(result: Record<string, unknown>) {
    const id = record(result.turn)?.id;
    if (typeof id !== 'string') fail(typed('PROTOCOL_ERROR', 'Codex returned a turn without an ID.'));
    collector.beginTurn(id as string);
    if (interruptRequested) sendInterrupt();
  }
  function onResponse(id: unknown, message: Record<string, unknown>) {
    const error = record(message.error);
    if (id === REQUEST.interrupt) {
      // A turn that already ended rejects the interrupt; its completion is authoritative.
      return;
    }
    if (error) {
      const text = typeof error.message === 'string' ? error.message : 'Codex rejected a request.';
      if (id === REQUEST.thread && options.threadId && /no rollout found|not found/i.test(text)) fail(typed('SESSION_INVALID', 'Codex thread not found.'));
      // A server without these requests (Codex before 0.162) cannot show the turn's tools.
      if (ISOLATION_REQUESTS.includes(id)) fail(isolationFailure(`the server rejected the check (${text.slice(0, 120)}).`));
      const classified = classifyCodexTurnError({ message: text }, 'Codex rejected a request.');
      fail(typed(classified.code, classified.message));
    }
    const result = record(message.result);
    if (!result) fail(typed('PROTOCOL_ERROR', 'Codex returned a response without a result.'));
    if (id === REQUEST.initialize) onInitialized();
    else if (id === REQUEST.config) onConfig(result);
    else if (id === REQUEST.thread) onThread(result as Record<string, unknown>);
    else if (id === REQUEST.features) onFeatures(result);
    else if (id === REQUEST.mcpStatus) onMcpStatus(result);
    else if (id === REQUEST.turn) onTurn(result as Record<string, unknown>);
    else fail(typed('PROTOCOL_ERROR', 'Codex answered an unknown request.'));
  }

  const session: StdinSession = {
    start(opened, input) {
      channel = opened;
      prompt = input;
      send({ id: REQUEST.initialize, method: 'initialize', params: {
        clientInfo: { name: BRAND.PACKAGE_NAME, title: BRAND.NAME, version: BRAND.SERVER_VERSION },
        // `excludeTurns` on `thread/resume` is an experimental field.
        capabilities: { experimentalApi: true, requestAttestation: false } } });
    },
    interrupt(opened) {
      interruptRequested = true;
      // Before the turn exists there is nothing to interrupt; EOF ends the server.
      if (!collector.snapshot().turnId) { opened.close(); return; }
      sendInterrupt();
    },
  };

  function line(raw: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { fail(typed('PROTOCOL_ERROR', 'Invalid Codex JSON-RPC record.')); }
    const message = record(parsed);
    if (!message) fail(typed('PROTOCOL_ERROR', 'Invalid Codex JSON-RPC message.'));
    const msg = message as Record<string, unknown>;
    const hasId = typeof msg.id === 'number' || (typeof msg.id === 'string' && validEventIdentifier(msg.id));
    if (hasId && typeof msg.method === 'string') {
      if (!warnedRequest) {
        warnedRequest = true;
        options.onEvent?.({ type: 'warning', message: `Declined a Codex '${msg.method.slice(0, 64)}' request in read-only mode.` });
      }
      send({ id: msg.id, error: { code: -32601, message: `${BRAND.NAME} runs Codex read-only and does not answer server requests.` } });
      return;
    }
    if (hasId) onResponse(msg.id, msg);
    else if (typeof msg.method === 'string') {
      try { collector.notify(msg.method, msg.params); }
      finally { if (collector.isTerminal()) channel?.close(); }
    } else fail(typed('PROTOCOL_ERROR', 'Invalid Codex JSON-RPC message.'));
  }

  return { session, line, resolvedModel: () => resolvedModel };
}
