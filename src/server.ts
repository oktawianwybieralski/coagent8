import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool, Resource, ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { createProgressReporter } from './execution/progress.js';
import { resolveWorkspacePath } from './paths.js';
import { redactDiagnostic } from './redaction.js';
import { BRAND, CANONICAL_TOOL_NAMES } from './constants.js';
import { SERVER_ICON } from './generated/server-icon.js';
import { doctorToolDefinition, handleDoctor } from './tools/doctor.tool.js';
import { sessionToolDefinition, cancelToolDefinition, handleSession, handleCancelSession } from './tools/session.tool.js';
import { getCanonicalReviewToolDefinition, handleReview } from './tools/review.tool.js';
import { getCanonicalConsultToolDefinition, handleConsult } from './tools/consult.tool.js';
import { getCanonicalAnalyzeToolDefinition, handleAnalyze } from './tools/analyze.tool.js';
import { getCanonicalDebugToolDefinition, handleDebugError } from './tools/debug.tool.js';
import { getCanonicalImplementToolDefinition, handleImplement } from './tools/implement.tool.js';
import { runToolDefinition, handleRun } from './tools/run.tool.js';
import { issueToolDefinition, handleIssue } from './tools/issue.tool.js';
import { executionOutputSchema, runOutputSchema, formatExecutionResult } from './tools/result.js';
import { ERROR_CODES } from './conversation.js';
import { listSessions } from './sessions/session.js';
import { sanitizeHandle } from './sessions/identity.js';
import { getHistory } from './sessions/history.js';
import { composeExecutionCancellation } from './execution/controller.js';
import { providerForClient, setCallerProvider } from './backends/routing.js';
import type { ToolArguments } from './tools/arguments.js';

export type ToolDefinition = Omit<Tool, 'inputSchema' | 'outputSchema'> & { inputSchema: { type: string; properties?: Record<string, object>; required?: string[] }; outputSchema?: { type: string; [key: string]: unknown } };

const executionNames = new Set<string>([
  CANONICAL_TOOL_NAMES.CONSULT,
  CANONICAL_TOOL_NAMES.REVIEW,
  CANONICAL_TOOL_NAMES.ANALYZE,
  CANONICAL_TOOL_NAMES.DEBUG,
  CANONICAL_TOOL_NAMES.IMPLEMENT,
  CANONICAL_TOOL_NAMES.RUN,
]);

function buildToolDefinitionsWithSchemas(tools: ToolDefinition[]): Tool[] {
  return tools.map(tool => {
    const { outputSchema: configuredOutput, ...definition } = tool;
    const outputSchema = configuredOutput
      ? configuredOutput
      : tool.name === CANONICAL_TOOL_NAMES.RUN
        ? runOutputSchema
        : executionNames.has(tool.name)
          ? executionOutputSchema
          : undefined;

    // The brand icon is declared once, on the server; tools carry no copy of it.
    return {
      ...definition,
      inputSchema: { ...tool.inputSchema, type: 'object' as const, additionalProperties: false },
      ...(outputSchema ? { outputSchema: outputSchema as Tool['outputSchema'] } : {}),
    };
  });
}

/**
 * Six canonical domain tools defined by the SURFACE-001 public contract.
 */
export function getCoreCanonicalTools(): ToolDefinition[] {
  return [
    getCanonicalConsultToolDefinition(),
    getCanonicalReviewToolDefinition(),
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
  return [
    getCanonicalAnalyzeToolDefinition(),
    getCanonicalDebugToolDefinition(),
    getCanonicalImplementToolDefinition(),
  ];
}


export function getAllCallableToolDefinitions(): Tool[] {
  return buildToolDefinitionsWithSchemas([
    ...getCoreCanonicalTools(),
    ...getLegacyAliasTools(),
    runToolDefinition,
  ]);
}

/**
 * Returns the advertised tool definitions: the six core tools, for every client.
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
    if (s.enum && !s.enum.includes(v)) throw new Error(`Invalid ${name}: expected one of ${s.enum.join(', ')}.`);
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
      throw new Error(`Invalid ${name}: expected ${types.join(' or ')}.`);
    if (typeof v === 'string' && !v.trim() && s.minLength !== 0) throw new Error(`Invalid ${name}: string must not be empty.`);
    if (typeof v === 'string' && s.minLength && v.length < s.minLength) throw new Error(`Invalid ${name}: string too short.`);
    if (typeof v === 'number' && (!Number.isFinite(v) || (s.minimum != null && v < s.minimum) || (s.maximum != null && v > s.maximum)))
      throw new Error(`Invalid ${name}: outside allowed range.`);
    if (Array.isArray(v) && s.items) v.forEach((entry, i) => validate(entry, s.items!, `${name}[${i}]`));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of s.required || []) if (obj[key] == null) throw new Error(`Missing required ${name}.${key}.`);
      for (const [key, entry] of Object.entries(obj)) {
        if (!s.properties?.[key]) {
          if (s.additionalProperties === false) throw new Error(`Unknown ${name}.${key}.`);
        } else validate(entry, s.properties[key], `${name}.${key}`);
      }
    }
  }
  const args = value ?? {};
  validate(args, schema, field);
  return args as Record<string, unknown>;
}

/**
 * Server-wide guidance for the client model. Every client includes it on every turn, so it
 * stays one sentence; call-time rules live in the parameter descriptions (`schema.ts`).
 */
export const SERVER_INSTRUCTIONS = 'Second opinion or code review from another local coding agent (Codex, Claude Code, Antigravity) in a read-only sandbox.';

export function createServer(): Server {
  composeExecutionCancellation();
  const server = new Server(
    {
      name: BRAND.SERVER_NAME,
      title: BRAND.NAME,
      version: BRAND.SERVER_VERSION,
      websiteUrl: `https://github.com/${BRAND.GITHUB_OWNER}/${BRAND.GITHUB_REPO}`,
      icons: [{ ...SERVER_ICON, sizes: [...SERVER_ICON.sizes] }],
    },
    { capabilities: { tools: {}, resources: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS }
  );

  server.oninitialized = () => setCallerProvider(providerForClient(server.getClientVersion()?.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: createToolDefinitions() }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const sessions = listSessions();
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
    if (uri === 'coagent8://sessions') {
      const sessions = listSessions();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sessions, null, 2),
          },
        ],
      };
    }

    const match = uri.match(/^coagent8:\/\/sessions\/([^/]+)\/history$/);
    if (match) {
      const handle = match[1];
      if (!sanitizeHandle(handle)) throw new Error(`Invalid session handle in URI: ${handle}`);
      const h = await getHistory(handle);
      if (!h) throw new Error(`Session history not found for handle: ${handle}`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(h, null, 2),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const progress = createProgressReporter(server, request.params._meta?.progressToken);
    try {
      const definition = getAllCallableToolDefinitions().find(tool => tool.name === name);
      if (!definition) throw new Error(`Unknown tool: ${name}`);
      // The canonical schemas validate each declared primitive/array field here;
      // handlers receive the corresponding narrowed contributor type.
      const args = validateToolArguments(request.params.arguments, definition.inputSchema as Schema) as ToolArguments;

      const cwd = resolveWorkspacePath(args.workspace_path as string | undefined);

      switch (name) {
        case CANONICAL_TOOL_NAMES.DOCTOR:
          return await handleDoctor(args as { backend?: string; detail?: string; quota?: boolean });
        case CANONICAL_TOOL_NAMES.SESSION:
          return await handleSession(args);
        case CANONICAL_TOOL_NAMES.CANCEL:
          return await handleCancelSession(args as { session_handle: string; workspace_path?: string });
        case CANONICAL_TOOL_NAMES.RUN:
          return await handleRun(args, cwd, extra.signal, progress);
        case CANONICAL_TOOL_NAMES.REVIEW:
          return await handleReview(name, args, cwd, extra.signal, progress);
        case CANONICAL_TOOL_NAMES.CONSULT:
          return await handleConsult(name, args, cwd, extra.signal, progress);
        case CANONICAL_TOOL_NAMES.ANALYZE:
          return await handleAnalyze(name, args, cwd, extra.signal, progress);
        case CANONICAL_TOOL_NAMES.DEBUG:
          return await handleDebugError(args, cwd, extra.signal, progress);
        case CANONICAL_TOOL_NAMES.IMPLEMENT:
          return await handleImplement(args, cwd, extra.signal, progress);
        case CANONICAL_TOOL_NAMES.ISSUE:
          return await handleIssue(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const message = redactDiagnostic((err as Error).message);
      if (executionNames.has(name)) {
        const raw = request.params.arguments;
        const provider = typeof raw?.backend === 'string' && ['codex', 'gemini', 'claude'].includes(raw.backend) ? raw.backend : null;
        const code = ERROR_CODES.find(code => message.startsWith(code + ':')) || 'INPUT_LIMIT';
        return formatExecutionResult(
          provider,
          {
            status: code === 'ABORTED' ? 'cancelled' : code === 'TIMEOUT' ? 'timed_out' : 'failed',
            isError: true,
            output: '',
            truncated: false,
            continuationAvailable: false,
            error: { code, message, retryable: false },
          },
          '',
          sanitizeHandle(typeof raw?.session_handle === 'string' ? raw.session_handle : null),
          { turn: 0, toolCount: 0, durationMs: 0, historyAvailable: false },
          { requireEnvelope: name === CANONICAL_TOOL_NAMES.REVIEW }
        );
      }
      return { isError: true, content: [{ type: 'text', text: `${BRAND.NAME}: ${message}` }] };
    } finally {
      progress.close();
    }
  });
  return server;
}
