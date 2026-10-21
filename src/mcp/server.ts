import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import type { ElicitResult, Tool, Resource, ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { createProgressReporter } from './progress.js';
import { chooseWorkspace, deletedSessionWorkspace, type ResolvedWorkspace } from '../workspace/workspace.js';
import { redactDiagnostic } from '../security/redaction.js';
import { BRAND } from '../brand.js';
import { CANONICAL_TOOL_NAMES, SERVER_INSTRUCTIONS } from './constants.js';
import { SERVER_ICONS } from '../generated/server-icon.js';
import { doctorToolDefinition, handleDoctor } from './tools/doctor.tool.js';
import { sessionToolDefinition, cancelToolDefinition, handleSession, handleCancelSession, publicSessionRecord } from './tools/session.tool.js';
import { getCanonicalReviewToolDefinition, handleReview } from './tools/review.tool.js';
import { getCanonicalConsultToolDefinition, handleConsult } from './tools/consult.tool.js';
import { getCanonicalDelegateToolDefinition, handleDelegate, type DelegateArguments } from './tools/delegate.tool.js';
import { handleLegacyAlias, legacyAliasToolDefinitions } from './tools/legacy.js';
import { runToolDefinition, handleRun } from './tools/run.tool.js';
import { issueToolDefinition, handleIssue } from './tools/issue.tool.js';
import { formatExecutionResult, setResultStyle, withWorkspace } from './result.js';
import { ToolError, errorCodeOf, type ExecutionBudget, type BackendReadContext, type MonotonicClock } from '../contracts/index.js';
import { createExecutionBudget } from '../execution/runtime/budget.js';
import { listSessions, isBudgetExpired } from '../sessions/session.js';
import { combineSignals } from '../storage/lock.js';
import { canonicalPath } from '../workspace/identity.js';
import { sanitizeHandle } from '../sessions/identity.js';
import { getHistory } from '../sessions/history/index.js';
import { composeExecutionCancellation, type ConsentPrompt } from '../execution/controller.js';
import { providerForClient, setCallerProvider } from '../execution/routing.js';
import { isValidModelIdentifier } from '../models/identifier.js';
import type { ToolArguments } from './arguments.js';

export { SERVER_INSTRUCTIONS };

export type ToolDefinition = Omit<Tool, 'inputSchema' | 'outputSchema'> & { inputSchema: { type: string; properties?: Record<string, object>; required?: string[] }; outputSchema?: { type: string; [key: string]: unknown } };

const executionNames = new Set<string>([
  CANONICAL_TOOL_NAMES.CONSULT,
  CANONICAL_TOOL_NAMES.REVIEW,
  CANONICAL_TOOL_NAMES.DELEGATE,
  CANONICAL_TOOL_NAMES.ANALYZE,
  CANONICAL_TOOL_NAMES.DEBUG,
  CANONICAL_TOOL_NAMES.IMPLEMENT,
  CANONICAL_TOOL_NAMES.RUN,
]);

function buildToolDefinitionsWithSchemas(tools: ToolDefinition[]): Tool[] {
  return tools.map(tool => {
    // Execution tools declare no outputSchema: their result is markdown only (CONTEXT-001).
    const { outputSchema, ...definition } = tool;

    // The brand icon is declared once, on the server; tools carry no copy of it.
    return {
      ...definition,
      inputSchema: { ...tool.inputSchema, type: 'object' as const, additionalProperties: false },
      ...(outputSchema ? { outputSchema: outputSchema as Tool['outputSchema'] } : {}),
    };
  });
}

/**
 * Canonical domain tools: the six of the SURFACE-001 public contract and `delegate` (`DELEGATE-001w`).
 */
export function getCoreCanonicalTools(): ToolDefinition[] {
  return [
    getCanonicalConsultToolDefinition(),
    getCanonicalReviewToolDefinition(),
    getCanonicalDelegateToolDefinition(),
    doctorToolDefinition,
    sessionToolDefinition,
    cancelToolDefinition,
    issueToolDefinition,
  ];
}

/**
 * Legacy tools aliased to consult. They stay callable through 1.0.x (removal planned for v1.1.0)
 * but are not advertised, so their definitions cost no client context.
 */
export function getLegacyAliasTools(): ToolDefinition[] {
  return legacyAliasToolDefinitions();
}

export function getAllCallableToolDefinitions(): Tool[] {
  return buildToolDefinitionsWithSchemas([
    ...getCoreCanonicalTools(),
    ...getLegacyAliasTools(),
    runToolDefinition,
  ]);
}

/**
 * Returns the advertised tool definitions: the core tools, for every client.
 */
export function createToolDefinitions(): Tool[] {
  return buildToolDefinitionsWithSchemas(getCoreCanonicalTools());
}

/**
 * Recursive subset of JSON Schema supported by {@link validateToolArguments}.
 *
 * @remarks
 * This describes the validator's supported keywords, not the full JSON Schema
 * specification. Nested properties and array items use the same subset.
 */
export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
};

export function validateToolArguments(value: unknown, schema: Schema, field = 'arguments'): Record<string, unknown> {
  function validate(v: unknown, s: Schema, name: string): void {
    if (s.enum && !s.enum.includes(v)) throw new ToolError('INPUT_LIMIT', `Invalid ${name}: expected one of ${s.enum.join(', ')}.`);
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (
      s.type &&
      !types.some(t =>
        t === 'object'
          ? !!v && typeof v === 'object' && !Array.isArray(v)
          : t === 'array'
          ? Array.isArray(v)
          : t === 'integer'
          ? Number.isSafeInteger(v)
          : t === 'null'
          ? v === null
          : typeof v === t
      )
    )
      throw new ToolError('INPUT_LIMIT', `Invalid ${name}: expected ${types.join(' or ')}.`);
    if (typeof v === 'string' && !v.trim() && s.minLength !== 0) throw new ToolError('INPUT_LIMIT', `Invalid ${name}: string must not be empty.`);
    if (typeof v === 'string' && s.minLength && v.length < s.minLength) throw new ToolError('INPUT_LIMIT', `Invalid ${name}: string too short.`);
    if (typeof v === 'number' && (!Number.isFinite(v) || (s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum)))
      throw new ToolError('INPUT_LIMIT', `Invalid ${name}: outside allowed range.`);
    if (Array.isArray(v) && s.items) v.forEach((entry, i) => validate(entry, s.items!, `${name}[${i}]`));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of s.required || []) if (obj[key] == null) throw new ToolError('INPUT_LIMIT', `Missing required ${name}.${key}.`);
      for (const [key, entry] of Object.entries(obj)) {
        if (!s.properties?.[key]) {
          if (s.additionalProperties === false) throw new ToolError('INPUT_LIMIT', `Unknown ${name}.${key}.`);
        } else validate(entry, s.properties[key], `${name}.${key}`);
      }
    }
  }
  const args = value ?? {};
  validate(args, schema, field);
  return args as Record<string, unknown>;
}

/** Bound on the client's answer to roots/list. */
const ROOTS_TIMEOUT_MS = 5000;
/** Time the user has to answer a top-tier model approval request. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export function createServer(options?: { clock?: MonotonicClock }): Server {
  const serverClock = options?.clock;
  composeExecutionCancellation();
  const server = new Server(
    {
      name: BRAND.SERVER_NAME,
      title: BRAND.NAME,
      version: BRAND.SERVER_VERSION,
      websiteUrl: `https://github.com/${BRAND.GITHUB_OWNER}/${BRAND.GITHUB_REPO}`,
      icons: SERVER_ICONS.map(icon => ({ ...icon, sizes: [...icon.sizes] })),
    },
    // No resources/list_changed notifications are sent, so listChanged is not declared.
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.oninitialized = () => {
    const client = server.getClientVersion()?.name;
    setCallerProvider(providerForClient(client));
    setResultStyle(client);
  };

  // Client roots are read once per connection and again after the client reports a change.
  let clientRoots: Promise<string[]> | null = null;
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { clientRoots = null; });
  async function workspaceRoots(): Promise<string[] | null> {
    if (!server.getClientCapabilities()?.roots) return null;
    clientRoots ??= server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS })
      .then(result => result.roots.filter(root => root.uri.startsWith('file:')).map(root => fileURLToPath(root.uri)))
      .catch((cause: unknown) => { clientRoots = null; throw new ToolError('INPUT_LIMIT', 'Validation Error: The client did not answer roots/list; pass workspace_path.', { cause }); });
    return clientRoots;
  }
  async function resolveWorkspace(rawPath: string | undefined): Promise<ResolvedWorkspace> {
    return chooseWorkspace(rawPath, rawPath ? null : await workspaceRoots());
  }

  // A model the governance policy asks for runs only after the user approves it in the client
  // (AUD-P1-7). Without form elicitation there is no prompt and the controller refuses it.
  function consentPrompt(signal?: AbortSignal | null, budget?: ExecutionBudget): ConsentPrompt | undefined {
    if (!server.getClientCapabilities()?.elicitation?.form) return undefined;
    return async ({ backend, model, reason, offerRemember, budget: reqBudget, abortSignal: reqSignal }) => {
      const effectiveBudget = reqBudget ?? budget;
      const effectiveSignal = combineSignals(signal, reqSignal, effectiveBudget?.executionSignal);

      if (effectiveSignal?.aborted || isBudgetExpired(effectiveBudget)) {
        if (isBudgetExpired(effectiveBudget)) {
          throw new ToolError('TIMEOUT', 'Execution budget expired before requesting user consent.');
        }
        throw new ToolError('ABORTED', 'Request cancelled before requesting user consent.');
      }

      let timeout: number;
      if (effectiveBudget) {
        const remaining = effectiveBudget.remainingExecutionMs();
        if (remaining <= 0) {
          throw new ToolError('TIMEOUT', 'Execution budget expired before requesting user consent.');
        }
        timeout = remaining;
      } else {
        timeout = CONSENT_TIMEOUT_MS;
      }

      let answer: ElicitResult;
      try {
        answer = await server.elicitInput(
          {
            message: `${BRAND.NAME}: run '${model}' on ${backend}? ${reason}`,
            requestedSchema: {
              type: 'object',
              required: ['approve'],
              properties: {
                approve: { type: 'boolean', title: `Run ${model}`, default: true },
                ...(offerRemember ? { remember: { type: 'boolean', title: `Do not ask again for ${model}`, default: false } } : {}),
              },
            },
          },
          { signal: effectiveSignal ?? undefined, timeout }
        );
      } catch (cause) {
        if (effectiveSignal?.aborted) {
          if (isBudgetExpired(effectiveBudget)) {
            throw new ToolError('TIMEOUT', 'Execution budget expired while waiting for user consent.', { cause });
          }
          throw new ToolError('ABORTED', 'Request cancelled while waiting for the user.', { cause });
        }
        if (isBudgetExpired(effectiveBudget)) {
          throw new ToolError('TIMEOUT', 'Execution budget expired while waiting for user consent.', { cause });
        }
        const causeMsg = (cause as Error)?.message || '';
        if (/timed? ?out/i.test(causeMsg) || (cause as { code?: number })?.code === -32001) {
          throw new ToolError('TIMEOUT', `The approval request for model '${model}' timed out.`, { cause });
        }
        throw new ToolError('POLICY_DENIED', `The approval request for model '${model}' failed: ${(cause as Error).message}`, { cause });
      }

      // Late response after deadline or cancellation during wait must not start a turn:
      if (effectiveSignal?.aborted || isBudgetExpired(effectiveBudget)) {
        if (isBudgetExpired(effectiveBudget)) {
          throw new ToolError('TIMEOUT', 'Execution budget expired while waiting for user consent.');
        }
        throw new ToolError('ABORTED', 'Request cancelled while waiting for the user.');
      }

      // Only an accepted form with the box checked is consent (CUR-003); a missing field is not.
      const approved = answer.action === 'accept' && answer.content?.approve === true;
      return {
        approved,
        unanswered: answer.action === 'cancel',
        remember: approved && offerRemember && answer.content?.remember === true,
        backend,
        model,
      };
    };
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: createToolDefinitions() }));

  // Resources show only the sessions of the connection's workspace (client root or server
  // directory), the same scope the session tool enforces.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    let sessions: ReturnType<typeof listSessions> = [];
    try {
      sessions = listSessions((await resolveWorkspace(undefined)).path);
    } catch (err) {
      // Without one workspace (several roots, or a home-directory launch) only the index is listed.
      if (!(err instanceof ToolError && err.code === 'INPUT_LIMIT')) throw err;
    }
    const resources: Resource[] = [
      {
        uri: 'coagent8://sessions',
        name: 'Active Sessions',
        description: 'List of active CoAgent8 conversation sessions with metadata and turn state.',
        mimeType: 'application/json',
      },
      ...sessions.map(s => ({
        uri: `coagent8://sessions/${s.sessionHandle}/history`,
        name: `Session History: ${s.sessionHandle}`,
        description: `Durable conversation event history for session ${s.sessionHandle} (${s.backend}).`,
        mimeType: 'application/json',
      })),
    ];
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const resourceTemplates: ResourceTemplate[] = [
      {
        uriTemplate: 'coagent8://sessions/{id}/history',
        name: 'Session History',
        description: 'Durable event log history for a specific session handle.',
        mimeType: 'application/json',
      },
    ];
    return { resourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const workspace = (await resolveWorkspace(undefined)).path;
    if (uri === 'coagent8://sessions') {
      const sessions = listSessions(workspace).map(publicSessionRecord);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sessions),
          },
        ],
      };
    }

    const match = uri.match(/^coagent8:\/\/sessions\/([^/]+)\/history$/);
    if (match) {
      const handle = match[1];
      if (!sanitizeHandle(handle)) throw new Error(`Invalid session handle in URI: ${handle}`);
      const h = await getHistory(handle);
      if (!h || h.workspace !== canonicalPath(workspace)) throw new Error(`Session history not found in this workspace: ${handle}`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(h),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const progress = createProgressReporter(server, request.params._meta?.progressToken);
    let budget: ExecutionBudget | undefined;
    try {
      const definition = getAllCallableToolDefinitions().find(tool => tool.name === name);
      if (!definition) throw new ToolError('INPUT_LIMIT', `Unknown tool: ${name}`);
      // The canonical schemas validate each declared primitive/array field here;
      // handlers receive the corresponding narrowed contributor type.
      const args = validateToolArguments(request.params.arguments, definition.inputSchema as Schema) as ToolArguments;

      switch (name) {
        case CANONICAL_TOOL_NAMES.DOCTOR:
          return await handleDoctor(args as { backend?: string; detail?: string; scope?: string }, extra.signal);
        case CANONICAL_TOOL_NAMES.ISSUE:
          return await handleIssue(args);
        case CANONICAL_TOOL_NAMES.CANCEL:
          // Without workspace_path, cancel stays unscoped: the handle alone identifies the turn.
          return await handleCancelSession(args as { session_handle: string; workspace_path?: string });
        case CANONICAL_TOOL_NAMES.SESSION: {
          // Sessions of a deleted directory can still be listed, read and closed.
          const deleted = deletedSessionWorkspace(args.workspace_path);
          if (deleted) return await handleSession(args, deleted);
          break;
        }
      }
      if (executionNames.has(name) && !(name === CANONICAL_TOOL_NAMES.RUN && args.action === 'issue')) {
        budget = createExecutionBudget({
          totalBudgetMs: typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) ? args.timeout_ms : undefined,
          parentSignal: extra.signal,
          clock: serverClock,
        });
      }
      const workspace = await resolveWorkspace(args.workspace_path as string | undefined);
      const cwd = workspace.path;
      let readContext: BackendReadContext | undefined;
      if (budget) {
        readContext = {
          abortSignal: budget.executionSignal,
          budget,
          timeoutMs: budget.remainingExecutionMs(),
        };
      }
      const consent = { askConsent: consentPrompt(extra.signal, budget) };
      const execOptions = { ...consent, budget, context: readContext, ...(serverClock ? { clock: serverClock } : {}) };
      switch (name) {
        case CANONICAL_TOOL_NAMES.SESSION:
          return await handleSession(args, cwd);
        case CANONICAL_TOOL_NAMES.RUN:
          // The issue action returns a bug report, not an execution result.
          return args.action === 'issue'
            ? await handleRun(args, cwd, extra.signal, progress)
            : withWorkspace(await handleRun(args, cwd, extra.signal, progress, execOptions), workspace);
        case CANONICAL_TOOL_NAMES.REVIEW:
          return withWorkspace(await handleReview(name, args, cwd, extra.signal, progress, execOptions), workspace);
        case CANONICAL_TOOL_NAMES.CONSULT:
          return withWorkspace(await handleConsult(name, args, cwd, extra.signal, progress, execOptions), workspace);
        case CANONICAL_TOOL_NAMES.DELEGATE:
          // The schema validated `scope` and `checks` as string lists.
          return withWorkspace(await handleDelegate(args as unknown as DelegateArguments, cwd, extra.signal, progress, execOptions), workspace);
        case CANONICAL_TOOL_NAMES.ANALYZE:
        case CANONICAL_TOOL_NAMES.DEBUG:
        case CANONICAL_TOOL_NAMES.IMPLEMENT:
          return withWorkspace(await handleLegacyAlias(name, args, cwd, extra.signal, progress, execOptions), workspace);
        default:
          throw new ToolError('INPUT_LIMIT', `Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = redactDiagnostic((err as Error).message);
      if (executionNames.has(name)) {
        const raw = request.params.arguments;
        const provider = typeof raw?.backend === 'string' && ['codex', 'agy', 'claude'].includes(raw.backend) ? raw.backend : null;
        const code = errorCodeOf(err);
        // A call refused before launch names the model the caller asked for, not "provider default".
        const requestedModel = typeof raw?.model === 'string' && isValidModelIdentifier(raw.model) ? raw.model : undefined;
        const elapsedMs = budget
          ? (typeof budget.elapsedMs === 'function'
              ? budget.elapsedMs()
              : Math.max(0, Math.round(budget.totalBudgetMs - budget.remainingTotalMs())))
          : 0;
        return formatExecutionResult(
          provider,
          {
            status: code === 'ABORTED' ? 'cancelled' : code === 'TIMEOUT' ? 'timed_out' : 'failed',
            isError: true,
            output: '',
            ...(requestedModel ? { model: requestedModel } : {}),
            truncated: false,
            continuationAvailable: false,
            error: { code, message, retryable: false },
          },
          '',
          sanitizeHandle(typeof raw?.session_handle === 'string' ? raw.session_handle : null),
          { turn: 0, toolCount: 0, durationMs: elapsedMs, totalMs: elapsedMs, historyAvailable: false },
          { requireEnvelope: name === CANONICAL_TOOL_NAMES.REVIEW }
        );
      }
      return { isError: true, content: [{ type: 'text', text: `${BRAND.NAME}: ${message}` }] };
    } finally {
      budget?.dispose();
      progress.close();
    }
  });
  return server;
}

