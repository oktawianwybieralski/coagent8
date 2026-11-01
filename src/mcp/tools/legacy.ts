/**
 * Deprecated tools and `run` actions that map to `consult`.
 *
 * @remarks
 * They stay callable through 1.0.x (removal planned for v1.1.0) but are not
 * advertised. One table drives their tool definitions, the argument mapping and
 * the deprecation notices of both entry points: the tool and the `run` action.
 *
 * @packageDocumentation
 */

import type { ToolArguments, ToolProgress } from '../arguments.js';
import { EXECUTION_PARAMETERS } from '../schema.js';
import { handleConsult } from './consult.tool.js';
import { ToolError } from '../../contracts/index.js';
import type { TaskOptions } from '../../execution/controller.js';
import { CANONICAL_TOOL_NAMES } from '../constants.js';

export type LegacyAliasName =
  typeof CANONICAL_TOOL_NAMES.ANALYZE | typeof CANONICAL_TOOL_NAMES.DEBUG | typeof CANONICAL_TOOL_NAMES.IMPLEMENT;

/** Mapping contract exposed by LEGACY_ALIASES for deprecated tool compatibility. */
export interface LegacyAlias {
  /** Argument holding the request; it becomes the consult proposal. */
  input: 'task' | 'error_message' | 'specification';
  taskType: 'architecture' | 'debug' | 'implementation';
  /** `context` replaces the consult's specific questions; otherwise they pass through. */
  contextAsQuestions: boolean;
  description: string;
  /** Tool input properties besides the execution parameters. */
  properties: Record<string, object>;
}

const FILE_LIST = { type: 'array', items: { type: 'string' } };

export const LEGACY_ALIASES: Readonly<Record<LegacyAliasName, LegacyAlias>> = {
  analyze: {
    input: 'task',
    taskType: 'architecture',
    contextAsQuestions: false,
    description:
      '[Deprecated: Use consult with task_type="architecture" instead] Perform deep architectural, dependency, and structural code analysis in read-only mode using local CLI reasoning agents.',
    properties: {
      task: { type: 'string', description: 'The specific question, architectural aspect, or focus area to analyze.' },
      file_paths: { ...FILE_LIST, description: 'Optional list of files or directories to inspect.' },
    },
  },
  debug: {
    input: 'error_message',
    taskType: 'debug',
    contextAsQuestions: true,
    description:
      '[Deprecated: Use consult with task_type="debug" instead] Diagnose an error or stack trace using local CLI reasoning agents in read-only sandbox mode. Returns root cause analysis and a step-by-step fix recommendation.',
    properties: {
      error_message: { type: 'string', description: 'The complete error message or stack trace to diagnose.' },
      context: { type: 'string', description: 'What you were doing when the error occurred, relevant inputs, or recent changes.' },
      file_paths: { ...FILE_LIST, description: 'Optional list of relevant source files to provide context.' },
    },
  },
  implement: {
    input: 'specification',
    taskType: 'implementation',
    contextAsQuestions: true,
    description:
      '[Deprecated: Use consult with task_type="implementation" instead] Implement a well-specified component, complex algorithm, or class in read-only sandbox mode without writing to disk.',
    properties: {
      specification: { type: 'string', description: 'Detailed description of what to implement, including interface requirements.' },
      context_files: { ...FILE_LIST, description: 'Optional list of files that provide relevant types, interfaces, or context.' },
      file_paths: { ...FILE_LIST, description: 'Optional list of files or directories for context.' },
      context: { type: 'string', description: 'Optional background context or architectural details.' },
    },
  },
};

export function isLegacyAlias(name: unknown): name is LegacyAliasName {
  return typeof name === 'string' && Object.hasOwn(LEGACY_ALIASES, name);
}

/** Definitions of the deprecated tools; callable, never advertised. */
export function legacyAliasToolDefinitions() {
  return Object.entries(LEGACY_ALIASES).map(([name, alias]) => ({
    name,
    description: alias.description,
    inputSchema: { type: 'object', properties: { ...alias.properties, ...EXECUTION_PARAMETERS }, required: [alias.input] },
  }));
}

import type { BackendReadContext, ExecutionBudget, MonotonicClock, TimingObserver } from '../../contracts/execution.js';
import type { PhaseTracker } from '../../execution/runtime/timing.js';

/**
 * Runs a deprecated tool or `run` action as `consult` with its task type.
 * @param via - The entry point, which words the validation error and the deprecation notice.
 * @throws ToolError `INPUT_LIMIT` when the request argument is missing or blank.
 */
export async function handleLegacyAlias(
  name: LegacyAliasName,
  args: ToolArguments,
  workspaceCwd: string,
  abortSignal: AbortSignal | null = null,
  onProgress: ToolProgress = null,
  options: Pick<TaskOptions, 'askConsent'> & {
    onTiming?: TimingObserver;
    tracker?: PhaseTracker;
    clock?: MonotonicClock;
    budget?: ExecutionBudget;
    context?: BackendReadContext;
  } = {},
  via: 'tool' | 'run' = 'tool',
) {
  const alias = LEGACY_ALIASES[name];
  const request = args[alias.input];
  if (typeof request !== 'string' || !request.trim()) {
    throw new ToolError(
      'INPUT_LIMIT',
      `Validation Error: ${alias.input} must be a non-empty string${via === 'run' ? ` for action "${name}"` : ''}.`,
    );
  }
  const warning =
    via === 'run'
      ? `Subcommand '${name}' in run gateway is deprecated. Use action 'consult' with task_type='${alias.taskType}' instead.`
      : `Tool '${name}' is deprecated and will be removed in v1.1.0. Use 'consult' with task_type='${alias.taskType}' instead.`;
  const mapped: ToolArguments = {
    ...args,
    proposal: request,
    task_type: alias.taskType,
    specific_questions: alias.contextAsQuestions ? args.context : args.specific_questions,
  };
  return handleConsult(CANONICAL_TOOL_NAMES.CONSULT, mapped, workspaceCwd, abortSignal, onProgress, {
    ...options,
    warnings: [warning],
    askConsent: options.askConsent,
  });
}
