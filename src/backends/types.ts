/**
 * Result returned by an adapter probe operation inspecting CLI installation and authentication state.
 */
import type { AdapterEvent, ExecutionError, TerminalStatus } from '../conversation.js';

export interface AdapterProbeResult {
  /** Unique adapter identifier (e.g. 'codex', 'claude', 'gemini'). */
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
 * Output resulting from executing a prompt against a CLI adapter.
 */
export interface ExecutionResult {
  /** Whether execution failed or exited with an error. */
  isError: boolean;
  /** Bounded public answer or partial text; inspect truncated/status for completeness. */
  output: string;
  /** Optional error trace or failure message. */
  errorDetail?: string;
  /** Persistent conversation/thread identifier for multi-turn sessions. */
  threadId?: string | null;
  /** Process exit status code. */
  exitCode?: number | null;
  /** Legacy helpers may omit this; registered adapters require a terminal result. */
  status?: TerminalStatus;
  error?: ExecutionError;
  nativeSessionId?: string | null;
  signal?: NodeJS.Signals | null;
  model?: string;
  truncated?: boolean;
  continuationAvailable?: boolean;
  usage?: { source: 'provider'; inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface TerminalExecutionResult extends ExecutionResult {
  status: TerminalStatus;
  truncated: boolean;
  continuationAvailable: boolean;
}

/**
 * Options configuring adapter execution.
 */
export interface ExecutionOptions {
  /** Current working directory for CLI execution. */
  cwd?: string;
  /** Model override name. */
  model?: string;
  /** Reasoning effort level override. */
  reasoningEffort?: string;
  /** Cancellation signal for interrupting execution. */
  abortSignal?: AbortSignal;
  /** Real-time progress callback. */
  onProgress?: (info: { message?: string; percent?: number }) => void;
  /** Existing thread or session ID for resuming multi-turn conversation. */
  threadId?: string | null;
  /** Backend process-phase budget in milliseconds; defaults to 900,000, excluding controller preparation. */
  timeoutMs?: number;
  nativeSessionId?: string | null;
  onEvent?: (event: AdapterEvent) => void;
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
   * Reads the models the installed CLI offers, without a model call. Called only when a
   * caller names a model or effort, and by doctor; undefined when the CLI cannot say.
   */
  listModels?(): Promise<ModelCatalog | undefined>;
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

/** One model a CLI offers. */
export interface CatalogModel {
  /** Identifier the caller passes as `model`. */
  id: string;
  /** Accepted `reasoning_effort` values; empty when the model takes none. */
  efforts: string[];
  /**
   * The CLI needs an effort with this identifier: agy lists `gemini-3.8-flash-high`
   * and rejects `gemini-3.8-flash` without `--effort`.
   */
  effortRequired?: boolean;
  /** The CLI's default model. */
  isDefault?: boolean;
}

/** Models offered by one backend CLI, read from the CLI itself. */
export interface ModelCatalog {
  models: CatalogModel[];
  /** Where the list comes from, for example `codex app-server model/list`. */
  source: string;
}

export type QuotaStatus = 'operational' | 'uninstalled' | 'rate_limited';

export interface BackendQuota {
  installed: boolean;
  executionSupported?: boolean;
  status: QuotaStatus;
  window: string;
  usedPercent: number | null;
  resetsAt: string | null;
  cooldownUntil: string | null;
  headroomPercent: number | null;
  measured: boolean;
  cooldownReason?: string | null;
  cooldownLevel?: number;
  lastCooldownAt?: string | null;
}

export interface QuotaReport {
  [backendId: string]: BackendQuota;
}

export interface QuotaCacheRecord {
  timestamp: number;
  data: QuotaReport;
}
