/**
 * Adapter-local types and contracts for backend CLI adapters.
 * Shared execution, model catalog, and quota contracts are defined in `src/contracts/`.
 *
 * @packageDocumentation
 */

import type {
  AdapterEvent,
  ExecutionResult,
  TerminalExecutionResult,
  ExecutionOptions,
  ModelCatalog,
} from '../contracts/index.js';

// Re-export shared contracts for consumers
export type {
  ExecutionResult,
  TerminalExecutionResult,
  ExecutionOptions,
  CatalogModel,
  ModelCatalog,
  QuotaStatus,
  BackendQuota,
  QuotaReport,
  QuotaCacheRecord,
} from '../contracts/index.js';

export interface AdapterProbeResult {
  /** Unique adapter identifier (e.g. 'codex', 'claude', 'agy'). */
  id?: string;
  /** Human-readable adapter display name. */
  name?: string;
  /** Whether the CLI binary was detected on the host system. */
  installed: boolean;
  /** Resolved binary path or command name. */
  command?: string;
  /** Detected CLI version string. */
  version?: string;
  /** Filesystem path to CLI executable. */
  path?: string;
  /**
   * Adapter-specific configuration metadata; `defaultModel` only when the CLI's own
   * configuration names one (Codex `config.toml`).
   */
  config?: { defaultModel?: string; defaultReasoningEffort?: string; sandboxMode?: string };
  /** Path to local CLI configuration directory or file. */
  configPath?: string;
  /** Probe-known identifiers or aliases; not necessarily a complete native catalog. */
  availableModels?: string[];
  /** Probe-known efforts, such as low, medium, high and xhigh; model catalogs may narrow them. */
  supportedReasoningEfforts?: string[];
  /** Adapter-reported auth evidence; authenticated can be inferred and does not prove a model turn. */
  authStatus?: string;
  /** Authentication method in use (e.g. 'chatgpt', 'api_key', 'oauth'). */
  authMethod?: string;
  /** Logged-in username or profile identifier. */
  activeAccount?: string;
  /** Alternative account identifier alias. */
  account?: string;
  /** Guidance command for signing in if unauthenticated. */
  loginHint?: string;
  executionSupported?: boolean;
  /** Profile capability evidence from the probe, distinct from each run's startup verification. */
  capabilities?: { resume: boolean; streaming: boolean; readOnlyVerified: boolean; reasoningEffort: boolean };
  modelSource?: string;
  authEvidence?: string[];
  quota?: {
    measured: boolean;
    headroomPercent?: number | null;
    usedPercent?: number | null;
    resetsAt?: string | null;
    window?: string;
    buckets?: Array<{ id: string; name: string; window: string; remainingFraction: number; resetTime: string }>;
  };
}

/**
 * Unified contract implemented by all CLI backend adapters.
 */
export interface CliAdapter {
  /** Unique backend identifier. */
  id: string;
  /** Human-readable backend name. */
  name: string;
  /** Probes the environment to verify CLI presence, version, and auth status. */
  probe(): Promise<AdapterProbeResult>;
  /**
   * Asks the CLI, without a model turn, which concrete model it runs for a requested name, or
   * without one, for CLIs that resolve names themselves (Claude Code aliases, its account
   * default). The controller passes the answer to `execute`, so consent and the turn name
   * the same model. Undefined when the CLI cannot say.
   */
  observeModel?(requested?: string, probe?: AdapterProbeResult): Promise<string | undefined>;
  /**
   * Executes a prompt in a read-only sandboxed CLI process. `options.model` is the model the
   * controller selected; an adapter refuses a turn without one rather than let the CLI choose.
   */
  execute(prompt: string, options?: ExecutionOptions): Promise<TerminalExecutionResult>;
  /**
   * Reads measured native quota without a model call, for adapters whose probe does not include it.
   * Called by native quota diagnostics; ordinary routing reuses cached measurements.
   * Never called by `execute`.
   */
  inspectQuota?(probe?: AdapterProbeResult): Promise<AdapterProbeResult['quota']>;
  /**
   * Reads the models the installed CLI offers, without a model call. Called when a turn
   * selects or checks a model, and by doctor; undefined when the CLI cannot say.
   * @param probe - The current probe, for the version and executable it found.
   */
  listModels?(probe?: AdapterProbeResult): Promise<ModelCatalog | undefined>;
  /**
   * Reads, without a model call, the MCP servers and plugins of the user's CLI configuration
   * that its turns offer the model and the adapter cannot disable (`CUR-002`). Called only
   * by doctor; undefined when the CLI cannot say.
   */
  inheritedTools?(): Promise<InheritedTools | undefined>;
}

/** Tools a backend's turns inherit from the user's CLI configuration. */
export interface InheritedTools {
  /** Enabled MCP servers. */
  mcpServers: string[];
  /** Enabled plugins, which can bring further MCP servers and hooks. */
  plugins: string[];
}
