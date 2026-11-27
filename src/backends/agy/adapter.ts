import { createGeminiCollector, MAX_DENIED_ACTIONS } from './collector.js';
import { classifyGeminiError, isNetworkFailure, isOutputLimitError } from './errors.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_TIMEOUT_MS, runCommand } from '../../execution/process.js';
import { summarizeQuotaWindows } from '../quota.js';
import { redactDiagnostic } from '../../security/redaction.js';
import { isValidModelIdentifier } from '../../models/identifier.js';
import { resolveCliCommand } from '../../execution/cli-resolver.js';
import { turnEnvironment } from '../../execution/nested-turn.js';
import { configuredBackendCommand, probeCommand } from '../executable.js';
import { getAgyProfileDir } from '../../paths.js';
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MODEL_LIST_TIMEOUT_MS,
  type AdapterProbeResult,
  type BackendReadContext,
  type CatalogModel,
  type ExecutionOptions,
  type InheritedTools,
  type ModelCatalog,
  type TerminalExecutionResult,
  type CliAdapter,
} from '../types.js';
import { errorCodeOf, ToolError, type AdapterEvent, type ExecutionError, type MonotonicClock } from '../../contracts/index.js';

export const id = 'agy';
export const name = 'Google Gemini (Antigravity agy)';
/** POSIX time agy gets between `SIGTERM` and `SIGKILL` to shut down its session and commands. */
const AGY_SIGNAL_GRACE_MS = 2000;
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/**
 * Sent once on `--conversation <id>` when a turn ends without an answer because headless
 * mode denied an action (#20); turns skip permission prompts (#211), so this is rare.
 */
export const SANDBOX_DENIAL_RECOVERY_PROMPT =
  'An action was denied and your previous turn ended without an answer. Answer the previous request now, in the format it asks for, without that action, and say what you could not check.';

/**
 * Sent once on `--conversation <id>` when a workspace-write turn ends without an answer after
 * a denial; natively, the same conversation then finished its edits (agy 1.4.12, 2026-10-31, #92).
 * @param workspace - The workspace directory the turn was started in.
 * @param deniedActions - Validated action names from agy's denial report.
 */
export function writeDenialRecoveryPrompt(workspace: string, deniedActions: readonly string[]): string {
  return (
    `Headless mode ${deniedSummary(deniedActions)} and your previous turn ended without an answer. Continue the previous task now. ` +
    `Read and edit only files inside ${workspace}, never another checkout of this repository, do not retry the denied action, ` +
    'and answer in the format the task asks for.'
  );
}

/** The denial named in an error or warning: the validated action names, or that agy named none. */
function deniedSummary(deniedActions: readonly string[]): string {
  if (!deniedActions.length) return 'denied an action it did not name';
  return `denied ${deniedActions.length === 1 ? 'action' : 'actions'} ${deniedActions.join(', ')}`;
}

/**
 * Creates a deterministic per-retry event identifier mapper that stays within the 256 UTF-8
 * byte contract and never collapses distinct long or multibyte identifiers (#20).
 *
 * @remarks The mapper renames every identifier it receives. The denial-recovery caller in
 * {@link execute} passes it step message and tool identifiers only and keeps `final` unmapped on
 * purpose (FEEDBACK-061i): the first turn ended without an answer, so the recovery turn's terminal
 * answer takes the canonical `final` message instead of a separate `retry-final`.
 */
export function createRetryIdMapper(initialIds?: Iterable<string>): (id: string) => string {
  const mapped = new Map<string, string>();
  const used = new Set<string>(initialIds);
  let nextOverflowSeq = 1;
  return (rawId: string): string => {
    const existing = mapped.get(rawId);
    if (existing !== undefined) return existing;
    const candidate = `retry-${rawId}`;
    if (Buffer.byteLength(candidate, 'utf8') <= 256 && !used.has(candidate)) {
      mapped.set(rawId, candidate);
      used.add(candidate);
      return candidate;
    }
    let fallback = `retry-id-${nextOverflowSeq++}`;
    while (used.has(fallback)) {
      fallback = `retry-id-${nextOverflowSeq++}`;
    }
    mapped.set(rawId, fallback);
    used.add(fallback);
    return fallback;
  };
}

function mergeUsage(first: TerminalExecutionResult['usage'], second: TerminalExecutionResult['usage']): TerminalExecutionResult['usage'] {
  if (!first || !second) return undefined;
  const merged: NonNullable<TerminalExecutionResult['usage']> = { source: 'provider' };
  if (typeof first.inputTokens === 'number' && typeof second.inputTokens === 'number') {
    merged.inputTokens = first.inputTokens + second.inputTokens;
  }
  if (typeof first.outputTokens === 'number' && typeof second.outputTokens === 'number') {
    merged.outputTokens = first.outputTokens + second.outputTokens;
  }
  if (typeof first.totalTokens === 'number' && typeof second.totalTokens === 'number') {
    merged.totalTokens = first.totalTokens + second.totalTokens;
  }
  return merged;
}

/** Caps caller timeout to the operation's default bound (`EXEC-001-T08e`). */
function boundReadTimeout(context: BackendReadContext | undefined, defaultMs: number): number {
  if (context?.timeoutMs !== undefined && Number.isFinite(context.timeoutMs) && context.timeoutMs > 0) {
    return Math.min(context.timeoutMs, defaultMs);
  }
  return defaultMs;
}

function effectiveAbortSignal(context?: BackendReadContext): AbortSignal | undefined {
  return context?.abortSignal ?? context?.budget?.executionSignal;
}

function checkPreflight(context: BackendReadContext | undefined, operation: string): void {
  const signal = effectiveAbortSignal(context);
  if (signal?.aborted) {
    throw new ToolError('ABORTED', `${operation} cancelled before launch.`);
  }
  if (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut()) {
    throw new ToolError('TIMEOUT', `Execution budget expired before ${operation.toLowerCase()}.`);
  }
}

function checkPostRun(
  res: { status: string; error?: { code?: string } },
  context: BackendReadContext | undefined,
  operation: string,
): void {
  const signal = effectiveAbortSignal(context);
  if (signal?.aborted || res.error?.code === 'ABORTED' || res.status === 'cancelled') {
    if (context?.budget?.isTimedOut() || context?.budget?.isExecutionExpired()) {
      throw new ToolError('TIMEOUT', `Execution budget expired during ${operation.toLowerCase()}.`);
    }
    throw new ToolError('ABORTED', `${operation} cancelled.`);
  }
  if (res.status !== 'completed' && (context?.budget?.isExecutionExpired() || context?.budget?.isTimedOut())) {
    throw new ToolError('TIMEOUT', `Execution budget expired during ${operation.toLowerCase()}.`);
  }
}

export function resolveModelAndEffort(model?: string, reasoningEffort?: string): { model?: string; effort?: string } {
  const effort = reasoningEffort ? reasoningEffort.toLowerCase() : undefined;
  if (!model) {
    return { model: undefined, effort };
  }
  if (effort) {
    const suffixRegex = new RegExp(`-(?:${VALID_REASONING_EFFORTS.join('|')})$`, 'i');
    const cleanModel = model.replace(suffixRegex, '');
    return { model: cleanModel, effort };
  }
  return { model, effort: undefined };
}

/**
 * Environment of every agy launch that runs a turn or reads what a turn loads (turns, recovery,
 * resume, and the `mcp list` and `plugin list` of the profile check), with agy's auto-updater disabled.
 * @remarks agy 1.3.1 starts a background updater on its first launch after 15 minutes. On
 * Windows that updater starts another agy with a new console window, which takes the keyboard
 * focus for about half a second (WINDOWS-001, measured 2026-10-07). agy honours only `true`.
 * On Windows `USERPROFILE` is CoAgent8's own agy profile ({@link usesAgyProfile}); `HOME`
 * stays, because git and bash read it and agy does not (agy 1.5.18, 2026-11-27, #224).
 * It creates nothing: only a turn creates the profile ({@link ensureAgyProfile}). Setup's checks,
 * {@link probe}'s `--version`, `agy models` and `/usage` read no turn tools and use
 * {@link userAgyEnvironment}, so a read-only setup status or doctor creates no profile.
 * @param platform - The platform whose rules apply; the running one by default.
 * @returns A copy of this process's environment for one agy launch.
 */
export function agyEnvironment(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
  if (!usesAgyProfile(platform)) return env;
  const profile = getAgyProfileDir();
  // Windows environment names ignore case: a second spelling would leave two values for the child.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'USERPROFILE') delete env[key];
  env.USERPROFILE = profile;
  return env;
}

/**
 * Environment of agy launches that run no turn and read no turn tools (`--version`, `models`,
 * `/usage`, and `mcp list` outside Windows): the user's own, with agy's auto-updater disabled.
 */
function userAgyEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
}

/** Whether CoAgent8's agy profile exists yet; before the first turn on Windows it does not. */
export function agyProfileExists(): boolean {
  return fs.existsSync(getAgyProfileDir());
}

/**
 * Whether agy runs with CoAgent8's own profile on this platform (#224, owner decision 2026-11-27).
 * @param platform - The platform to decide for; the running one by default.
 * @remarks Only Windows: there agy finds its configuration through `USERPROFILE` (agy 1.5.18).
 * On macOS and Linux its lookup is unverified and `HOME` would also move git and the shell, so
 * turns there still offer the user's MCP servers and plugins (CUR-002).
 */
export function usesAgyProfile(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

/**
 * Creates CoAgent8's agy profile in the data directory, on the turn path only, before the profile
 * check that precedes a turn.
 * @returns Its path, or why it could not be created.
 * @remarks It has the data directory's permissions, like CoAgent8's sessions there: `mode` limits
 * it to the user on POSIX and sets no ACL on Windows.
 */
function ensureAgyProfile(): string | { failure: string } {
  const dir = getAgyProfileDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { failure: `the profile directory could not be created: ${redactDiagnostic((err as Error).message, 256)}` };
  }
  return dir;
}

/**
 * The `.gemini` directory whose configuration agy loads in a CoAgent8 call: the profile's on
 * Windows, otherwise the user's own (`GEMINI_CLI_HOME` or the home directory).
 */
export function agyConfigDir(platform: NodeJS.Platform = process.platform): string {
  return usesAgyProfile(platform)
    ? path.join(getAgyProfileDir(), '.gemini')
    : path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

/**
 * Marker of a conversation agy started in CoAgent8's profile. A session without one was started
 * in the user's own profile before #224, and agy cannot resume it from this profile.
 */
function profileConversationMarker(conversationId: string): string {
  return path.join(getAgyProfileDir(), '.coagent8', 'conversations', conversationId.toLowerCase());
}

/** Records that a conversation lives in CoAgent8's profile; a failed write only blocks its resume. */
function recordProfileConversation(conversationId: string): void {
  try {
    const marker = profileConversationMarker(conversationId);
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, '', { mode: 0o600 });
  } catch {
    // The next continuation is refused with a clear message instead; the answer stays valid.
  }
}

/** What the profile offers agy's model: configured MCP servers and plugins beyond agy's built-ins. */
export interface AgyProfileContents {
  mcpServers: string[];
  plugins: string[];
}

/**
 * Reads every MCP server and plugin configured in the profile that a CoAgent8 agy call loads.
 * @param cwd - The turn's working directory, so workspace-scoped agy configuration counts too.
 * @returns The contents, or the reason they could not be read.
 * @remarks `agy plugin list --json` names imported and discovered plugins (agy 1.5.18); the
 * directory scan also counts a plugin directory agy does not list, a disabled one included,
 * because a turn could enable it. Output that is not one of agy's known shapes fails the read.
 * agy's built-in `swarm` is only an entry in the profile's `config.json` plugins section, which
 * is no plugin of its own and is not counted; a listed plugin or directory named `swarm` is.
 */
async function readAgyProfileContents(
  resolved: ReturnType<typeof resolveCliCommand>,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  cwd?: string,
): Promise<{ contents: AgyProfileContents } | { failure: string; aborted?: boolean; timedOut?: boolean }> {
  const env = agyEnvironment();
  const run = (args: string[]) =>
    runCommand(resolved.command, [...resolved.argsPrefix, ...args], {
      timeoutMs,
      abortSignal,
      env,
      ...(cwd ? { cwd } : {}),
    });
  const [mcp, plugins] = await Promise.all([run(['mcp', 'list']), run(['plugin', 'list', '--json'])]);
  if (abortSignal?.aborted || mcp.status === 'cancelled' || plugins.status === 'cancelled') {
    return { failure: 'cancelled', aborted: true };
  }
  for (const [label, res] of [
    ['agy mcp list', mcp],
    ['agy plugin list --json', plugins],
  ] as const) {
    if (res.status !== 'completed' || res.exitCode !== 0) {
      return {
        failure: `${label} ended with status ${res.status} (exit code ${res.exitCode})`,
        ...(res.status === 'timed_out' ? { timedOut: true } : {}),
      };
    }
  }
  const mcpServers = configuredAgyMcpServers(mcp.stdout);
  if (!mcpServers) return { failure: 'agy mcp list printed output CoAgent8 does not recognize' };
  const listed = parseAgyPluginList(plugins.stdout);
  if (!listed) return { failure: 'agy plugin list --json printed output CoAgent8 does not recognize' };
  let discovered: string[];
  try {
    discovered = listAgyPlugins(path.join(agyConfigDir(), 'config'), { includeDisabled: true });
  } catch (err) {
    return { failure: `the profile's plugin directory could not be read: ${redactDiagnostic((err as Error).message, 256)}` };
  }
  return { contents: { mcpServers, plugins: [...new Set([...listed, ...discovered])] } };
}

/** Names what the profile contains, for an error or a doctor note. */
export function describeAgyProfileContents(contents: AgyProfileContents): string {
  return [
    contents.mcpServers.length ? `MCP servers ${contents.mcpServers.join(', ')}` : '',
    contents.plugins.length ? `plugins ${contents.plugins.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' and ');
}

/**
 * Requires that CoAgent8's agy profile configures no MCP server and no plugin (agy's own `swarm`
 * entry in `config.json` aside), before every agy turn (#224).
 * @param cwd - The turn's working directory; the check runs there, as the turn does.
 * @returns The refusal (`timed_out` when the turn's own deadline ends during the check), or
 * undefined when the profile is verified.
 * @remarks Nothing is cached: commands of a turn see the profile as `USERPROFILE` and can add a
 * server or plugin to it (`agy mcp add`), which the next turn would offer. Doctor reads the same
 * state through {@link inheritedTools}.
 */
async function verifyAgyProfile(
  resolved: ReturnType<typeof resolveCliCommand>,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  cwd: string | undefined,
): Promise<TerminalExecutionResult | undefined> {
  const read = await readAgyProfileContents(resolved, Math.min(timeoutMs, DEFAULT_MODEL_LIST_TIMEOUT_MS), abortSignal, cwd);
  if ('failure' in read) {
    if (read.aborted) return { ...failed({ code: 'ABORTED', message: 'Cancelled before launch.', retryable: false }), status: 'cancelled' };
    // The turn's own deadline ran out during the check: the turn timed out, it did not start.
    if (read.timedOut && timeoutMs <= DEFAULT_MODEL_LIST_TIMEOUT_MS) {
      return {
        ...failed({
          code: 'TIMEOUT',
          message: `The turn's time ran out while CoAgent8 verified its agy profile ${getAgyProfileDir()}, so agy did not start.`,
          retryable: true,
        }),
        status: 'timed_out',
      };
    }
    return failed({
      code: 'POLICY_DENIED',
      message: `CoAgent8 could not verify that its agy profile ${getAgyProfileDir()} has no MCP servers or plugins (${read.failure}), so the turn did not start.`,
      retryable: true,
    });
  }
  const named = describeAgyProfileContents(read.contents);
  if (named) {
    return failed({
      code: 'POLICY_DENIED',
      message:
        `CoAgent8's agy profile ${getAgyProfileDir()} contains ${named}, which agy would offer in this turn, so the turn did not start. ` +
        `Remove them with 'agy mcp remove <name>' and 'agy plugin uninstall <name>' run with USERPROFILE set to that directory, then retry.`,
      retryable: false,
    });
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Reads agy's `/usage` payload into a measured quota.
 * @param parsed - The parsed JSON output of `agy --output-format json -p /usage`.
 * @returns The bottleneck window, or undefined when no window reports `remaining_fraction`.
 * @remarks A window without `remaining_fraction` is unmeasured, never full headroom (AUD-P2-2).
 */
export function parseGeminiUsage(parsed: unknown): AdapterProbeResult['quota'] {
  const groups = asRecord(asRecord(asRecord(parsed)?.command)?.data)?.groups;
  if (!Array.isArray(groups)) return undefined;
  const records = groups.map(asRecord).filter((group): group is Record<string, unknown> => group !== undefined);
  const geminiGroup = records.find(group => /gemini/i.test(String(group.name ?? ''))) || records[0];
  if (!geminiGroup || !Array.isArray(geminiGroup.buckets)) return undefined;

  const buckets = geminiGroup.buckets
    .map(asRecord)
    .filter((bucket): bucket is Record<string, unknown> => typeof bucket?.remaining_fraction === 'number')
    .map(bucket => ({
      id: String(bucket.id ?? ''),
      name: String(bucket.name ?? ''),
      window: String(bucket.window ?? ''),
      remainingFraction: bucket.remaining_fraction as number,
      resetTime: String(bucket.reset_time ?? ''),
    }));

  const quota = summarizeQuotaWindows(buckets);
  return quota && { ...quota, window: quota.window || 'weekly' };
}

export async function probe(context?: BackendReadContext): Promise<AdapterProbeResult> {
  checkPreflight(context, 'Gemini probe');
  const resolvedCommand = probeCommand('agy', name);
  if ('unresolved' in resolvedCommand) return resolvedCommand.unresolved;
  const rawCommand = resolvedCommand.command;
  let installed = false;
  let version = 'unknown';

  // runCommand resolves the command and reports a missing or failing CLI in its result.
  const res = await runCommand(rawCommand, ['--version'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_PROBE_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    // The user's own environment, as setup's checks: `--version` runs no turn and reads nothing a
    // turn loads, so a read-only doctor creates no agy profile (#224). The updater stays off.
    env: userAgyEnvironment(),
  });
  checkPostRun(res, context, 'Gemini probe');
  if (res.exitCode === 0) {
    installed = true;
    version = res.stdout.trim() || 'installed';
  }

  const authEvidence: string[] = [];
  // The user's own profile: the sign-in lives outside it (Windows Credential Manager) and
  // carries over to CoAgent8's agy profile, whose files appear only after its first turn.
  const userGeminiDir = path.join(process.env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
  const antigravityState = path.join(userGeminiDir, 'antigravity', 'antigravity_state.pbtxt');
  const oauthCreds = path.join(userGeminiDir, 'oauth_creds.json');
  const googleAccounts = path.join(userGeminiDir, 'google_accounts.json');

  const hasApiKey = Boolean(process.env.GEMINI_API_KEY);
  const hasAntigravityState = fs.existsSync(antigravityState);
  const hasOauth = fs.existsSync(oauthCreds) || fs.existsSync(googleAccounts);

  if (hasApiKey) authEvidence.push('API key present (not verified)');
  if (hasAntigravityState) authEvidence.push('Antigravity state present (not verified)');
  if (hasOauth) authEvidence.push('Google OAuth credentials present (not verified)');
  if (authEvidence.length === 0) authEvidence.push('No local auth evidence');

  // Authentication is proven only by an execution or the quota read (`inspectQuota`).
  const authStatus = 'unknown';

  return {
    id,
    name,
    command: rawCommand,
    installed,
    version,
    executionSupported: installed,
    capabilities: {
      resume: true,
      streaming: true,
      readOnlyVerified: true,
      reasoningEffort: true,
    },
    authStatus,
    authEvidence,
    // Models come from `agy models` (`listModels`), read on demand.
    supportedReasoningEfforts: VALID_REASONING_EFFORTS,
    modelSource: 'agy models; the default is the configured one, else the first model agy lists',
    loginHint: 'agy',
  };
}

/**
 * Reads agy's measured quota with `/usage`, which makes no model call.
 * @param probe - An installed probe result; nothing is read without one.
 * @param context - Optional cancellation and deadline context (`EXEC-001-T08e`).
 * @returns The measured quota, or undefined when agy does not report one.
 * @remarks Runs only from quota inspection (doctor), never on the request path, and with
 * the same `--sandbox` as every other agy launch.
 */
export async function inspectQuota(probe?: AdapterProbeResult, context?: BackendReadContext): Promise<AdapterProbeResult['quota']> {
  checkPreflight(context, 'Gemini quota read');
  if (!probe?.installed) return undefined;
  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch {
    return undefined;
  }
  const usageRes = await runCommand(resolved.command, [...resolved.argsPrefix, '--sandbox', '--output-format', 'json', '-p', '/usage'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_PROBE_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    // The quota is the account's; `/usage` loads no turn tools and creates no profile (#224).
    env: userAgyEnvironment(),
  });
  checkPostRun(usageRes, context, 'Gemini quota read');
  if (usageRes.status !== 'completed' || usageRes.exitCode !== 0 || !usageRes.stdout) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(usageRes.stdout);
  } catch {
    return undefined;
  }
  const payload = parsed as { status?: unknown; command?: { name?: unknown } } | null;
  return payload?.status === 'SUCCESS' && payload.command?.name === 'usage' ? parseGeminiUsage(payload) : undefined;
}

function failed(error: ExecutionError): TerminalExecutionResult {
  return { status: 'failed', isError: true, output: '', error, errorDetail: error.message, truncated: false, continuationAvailable: false };
}

/**
 * Runs one agy turn: read-only in its sandbox, or for `workspace-write` without it.
 * @remarks Every turn passes `--model`: agy keeps the model last selected in its interface
 * in internal state, so its own choice is unknown before the turn and could be top-tier
 * (AUD-P1-7). The deadline and cancellation are `runCommand`'s: it validates `timeoutMs`,
 * stops the process and reports `timed_out` or `cancelled`, which this result keeps.
 * When a headless sandbox denial ends the turn with an empty answer, `execute` resumes the
 * same native conversation at most once within the remaining `timeoutMs` and `abortSignal`
 * to ask for an answer without shell commands (#20).
 */
export async function execute(
  prompt: string,
  options: ExecutionOptions & { clock?: MonotonicClock } = {},
): Promise<TerminalExecutionResult> {
  const model = options.model;
  if (model === undefined) {
    return failed({
      code: 'INPUT_LIMIT',
      message: 'No agy model selected; the controller passes the configured model or the first one agy lists.',
      retryable: false,
    });
  }
  if (!isValidModelIdentifier(model)) {
    return failed({ code: 'INPUT_LIMIT', message: 'Invalid Gemini model identifier.', retryable: false });
  }
  if (options.abortSignal?.aborted) {
    return { ...failed({ code: 'ABORTED', message: 'Cancelled before launch.', retryable: false }), status: 'cancelled' };
  }
  const native = options.nativeSessionId || options.threadId;
  if (native && !UUID.test(native)) {
    return failed({ code: 'SESSION_INVALID', message: 'Gemini resume requires an exact full UUID.', retryable: false });
  }
  if (options.reasoningEffort) {
    const norm = options.reasoningEffort.toLowerCase();
    if (!VALID_REASONING_EFFORTS.includes(norm)) {
      return failed({
        code: 'CLI_UNSUPPORTED',
        message: `Invalid reasoning effort '${options.reasoningEffort}'. Valid: ${VALID_REASONING_EFFORTS.join(', ')}`,
        retryable: false,
      });
    }
  }

  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    // A configured executable that is missing fails here like an absent CLI.
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch (err) {
    return failed({
      code: errorCodeOf(err) === 'CLI_UNSUPPORTED' ? 'CLI_UNSUPPORTED' : 'CLI_NOT_FOUND',
      message: redactDiagnostic((err as Error).message),
      retryable: false,
    });
  }

  // A conversation of the user's own profile cannot be resumed from CoAgent8's; continuing
  // it would start agy without its context, so the session ends here instead (#224).
  if (native && usesAgyProfile() && !fs.existsSync(profileConversationMarker(native))) {
    return failed({
      code: 'SESSION_INVALID',
      message:
        'This agy session was started in your own agy profile, before CoAgent8 ran agy with its own profile, so agy cannot resume it. Start a new session (without session_handle).',
      retryable: false,
    });
  }
  // The turn path is the only one that creates the profile, right before it is verified.
  const created = usesAgyProfile() ? ensureAgyProfile() : undefined;
  if (typeof created === 'object') {
    return failed({
      code: 'POLICY_DENIED',
      message: `CoAgent8 could not verify that its agy profile ${getAgyProfileDir()} has no MCP servers or plugins (${created.failure}), so the turn did not start.`,
      retryable: true,
    });
  }
  const refusal = usesAgyProfile()
    ? await verifyAgyProfile(
        resolved,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.abortSignal,
        options.cwd ? path.resolve(options.cwd) : process.cwd(),
      )
    : undefined;
  if (refusal) return refusal;

  const { model: targetModel, effort: targetEffort } = resolveModelAndEffort(model, options.reasoningEffort);

  // Every turn runs on the host without permission prompts (#211, owner decision 2026-11-21):
  // commands, edits and network reach what the user's account reaches. A delegate turn, the one
  // with a write scope, keeps its own recovery text and its stricter end-of-turn rules.
  const writes = options.writeScope !== undefined;
  const baseArgs = [...resolved.argsPrefix, '--dangerously-skip-permissions', '--output-format', 'stream-json'];
  const turnPrompt = prompt;
  if (options.cwd) {
    baseArgs.push('--add-dir', path.resolve(options.cwd));
  }
  if (targetModel) {
    baseArgs.push('--model', targetModel);
  }
  if (targetEffort) {
    baseArgs.push('--effort', targetEffort);
  }

  const resolvedCwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const env = turnEnvironment(agyEnvironment());

  const runTurn = async (
    turnPrompt: string,
    conversationId: string | null | undefined,
    timeoutMs: number,
    onEvent: ((event: AdapterEvent) => void) | undefined,
  ) => {
    const collector = createGeminiCollector(onEvent);
    const args = conversationId ? [...baseArgs, '--conversation', conversationId] : [...baseArgs];
    const processResult = await runCommand(resolved.command, args, {
      cwd: resolvedCwd,
      env,
      stdinInput: turnPrompt,
      abortSignal: options.abortSignal,
      timeoutMs,
      // agy has no headless interrupt; on POSIX, SIGTERM lets it cancel its own commands first.
      signalGraceMs: AGY_SIGNAL_GRACE_MS,
      maxBufferBytes: 512 * 1024,
      maxLineBytes: 512 * 1024,
      onStdoutLine: collector.line,
      onStderrLine(line) {
        if (/jetski:.*auto-denied/i.test(line)) {
          collector.denySandbox(line);
        }
      },
    });
    return { processResult, snapshot: collector.snapshot() };
  };

  const clock = options.clock ?? (() => performance.now());
  const effectiveTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAtMs = clock();
  const initialEventIds = new Set<string>();
  const initialOnEvent = options.onEvent
    ? (event: AdapterEvent) => {
        if (event.type === 'assistant_delta' || event.type === 'assistant_message') {
          initialEventIds.add(event.messageId);
        } else if (event.type === 'tool_started' || event.type === 'tool_finished') {
          initialEventIds.add(event.toolId);
        }
        options.onEvent?.(event);
      }
    : undefined;
  const first = await runTurn(turnPrompt, native, effectiveTimeoutMs, initialOnEvent);
  let processResult = first.processResult;
  let s = first.snapshot;
  let retriedAfterDenial = false;
  // The profile check before the recovery used up the turn's time: no recovery, the turn timed out.
  let timedOutBeforeRecovery = false;

  // A writer runs no command either, so it gets its own recovery prompt that keeps it in the workspace.
  const canRetryEmptyDenial =
    processResult.status === 'completed' &&
    !processResult.error &&
    !s.terminalError &&
    s.terminal &&
    Boolean(s.nativeSessionId) &&
    (!native || s.nativeSessionId === native) &&
    s.sandboxDenied &&
    !s.output.trim() &&
    !options.abortSignal?.aborted;

  let recoveryAllowed = canRetryEmptyDenial;
  // Charged only when time is left for the turn to start.
  if (canRetryEmptyDenial && effectiveTimeoutMs - Math.max(0, Math.round(clock() - startedAtMs)) > 0) {
    try {
      await options.beforeExtraTurn?.();
    } catch (err) {
      // A limit stops only the optional recovery; a cancellation or a deadline ends the turn as such.
      if (!(err instanceof ToolError && err.code === 'ROOT_LIMIT')) throw err;
      recoveryAllowed = false;
      options.onEvent?.({ type: 'warning', message: `No recovery turn ran: ${(err as Error).message}` });
    }
  }
  if (recoveryAllowed) {
    const elapsedMs = Math.max(0, Math.round(clock() - startedAtMs));
    const remainingTimeoutMs = effectiveTimeoutMs - elapsedMs;
    if (remainingTimeoutMs > 0) {
      const retrySessionId = s.nativeSessionId!;
      const mapRetryId = createRetryIdMapper(initialEventIds);
      const retryOnEvent = options.onEvent
        ? (event: AdapterEvent) => {
            // 'final' stays unmapped on purpose: the recovery answer is the turn's canonical final message.
            if ((event.type === 'assistant_delta' || event.type === 'assistant_message') && event.messageId !== 'final') {
              options.onEvent?.({ ...event, messageId: mapRetryId(event.messageId) });
            } else if (event.type === 'tool_started' || event.type === 'tool_finished') {
              options.onEvent?.({ ...event, toolId: mapRetryId(event.toolId) });
            } else {
              options.onEvent?.(event);
            }
          }
        : undefined;
      const recoveryPrompt = writes ? writeDenialRecoveryPrompt(resolvedCwd, s.deniedActions) : SANDBOX_DENIAL_RECOVERY_PROMPT;
      // The recovery is another agy launch: the first turn's commands may have added a server or
      // plugin to the profile, so it is verified again and not started when it refuses (#224).
      const recoveryRefusal = usesAgyProfile()
        ? await verifyAgyProfile(resolved, remainingTimeoutMs, options.abortSignal, resolvedCwd)
        : undefined;
      if (recoveryRefusal) {
        // The first turn's conversation lives in the profile and can be continued once it is clean.
        const sessionId = UUID.test(retrySessionId) ? retrySessionId : null;
        if (sessionId) recordProfileConversation(sessionId);
        const error = recoveryRefusal.error && {
          ...recoveryRefusal.error,
          message: `The automatic recovery turn did not start. ${recoveryRefusal.error.message}`,
        };
        return {
          ...recoveryRefusal,
          ...(error ? { error, errorDetail: error.message } : {}),
          nativeSessionId: sessionId,
          threadId: sessionId,
          continuationAvailable: Boolean(sessionId),
          usage: s.usage,
          model: s.model ?? targetModel,
        };
      }
      // The check took part of the turn's time: the recovery gets only what is left after it, and
      // none starts when nothing is left (#20: at most once within the remaining `timeoutMs`).
      const recoveryTimeoutMs = effectiveTimeoutMs - Math.max(0, Math.round(clock() - startedAtMs));
      if (recoveryTimeoutMs <= 0) {
        timedOutBeforeRecovery = true;
      } else {
        retriedAfterDenial = true;
        const second = await runTurn(recoveryPrompt, retrySessionId, recoveryTimeoutMs, retryOnEvent);
        processResult = second.processResult;
        const s2 = second.snapshot;
        s = {
          ...s2,
          model: s2.model ?? s.model,
          sandboxDenied: s.sandboxDenied || s2.sandboxDenied,
          deniedActions: [...new Set([...s.deniedActions, ...s2.deniedActions])].slice(0, MAX_DENIED_ACTIONS),
          truncated: s.truncated || s2.truncated,
          usage: mergeUsage(s.usage, s2.usage),
        };
      }
    }
  }

  // A denied action shows that the sandbox works; the answer stays, as with Claude permission denials.
  // The names reach the session history through this warning (#92).
  if (s.sandboxDenied)
    options.onEvent?.({
      type: 'warning',
      message: writes
        ? `agy headless mode ${deniedSummary(s.deniedActions)} during the change; the answer may be incomplete.`
        : `agy headless mode ${deniedSummary(s.deniedActions)}; the answer may be incomplete.`,
    });
  const expectedSessionId = retriedAfterDenial ? first.snapshot.nativeSessionId : native;
  const sessionMismatch = Boolean(expectedSessionId && s.nativeSessionId && s.nativeSessionId !== expectedSessionId);
  let error: ExecutionError | undefined = sessionMismatch
    ? { code: 'SESSION_INVALID', message: 'Resume returned a different Gemini session.', retryable: false }
    : processResult.error || s.terminalError;
  if (!error && processResult.status !== 'completed') {
    const fallbackStderr = processResult.stderr ? processResult.stderr.trim() : '';
    error = fallbackStderr
      ? classifyGeminiError(fallbackStderr)
      : {
          code: 'PROCESS_ERROR',
          message: `Gemini process failed with status ${processResult.status} (exit code ${processResult.exitCode}).`,
          retryable: false,
        };
  }
  // agy's own continuation retries ran out at the output token limit: the streamed text is a
  // usable, incomplete answer, not a process failure (#89). A review stopped there is never judged.
  // Only the output-limit error itself is cleared; any other failure stays a failure.
  const errorIsOutputLimit = error?.code === 'PROCESS_ERROR' && isOutputLimitError(error.message);
  const outputLimited = s.lengthLimited || errorIsOutputLimit;
  if (outputLimited && (!error || errorIsOutputLimit)) {
    error = s.output.trim()
      ? undefined
      : {
          code: 'PROCESS_ERROR',
          message:
            'agy stopped at its output token limit before it answered. Ask for a shorter answer in a new session (without session_handle).',
          retryable: false,
        };
  }
  if (outputLimited && !error)
    options.onEvent?.({
      type: 'warning',
      message:
        'agy stopped at its output token limit; the answer is incomplete. ' +
        'A follow-up in the same session can stop the same way: ask for the rest in a shorter form or in a new session.',
    });
  // The agent finished its answer and ran nothing after it; only a later request failed (#128).
  // A review and a change need a whole turn: there the failure stands.
  if (
    error?.code === 'PROCESS_ERROR' &&
    isNetworkFailure(error.message) &&
    s.answeredLast &&
    s.output.trim() &&
    !writes &&
    !options.requireCompleteTurn
  ) {
    options.onEvent?.({
      type: 'warning',
      message: `agy's next request failed after it wrote this answer, so the turn did not end by itself: ${error.message}`,
    });
    error = undefined;
  }
  if (!error && (!s.terminal || (!s.nativeSessionId && !expectedSessionId))) {
    error = { code: 'PROTOCOL_ERROR', message: 'Gemini omitted its terminal result or init metadata.', retryable: false };
  }
  // A more specific failure of the first turn stays when its recovery found no time (below).
  const firstTurnError = error;
  // A headless denial ends agy's turn before the model answers; an empty success is no answer.
  if (!error && s.sandboxDenied && !s.output.trim()) {
    error = {
      code: 'POLICY_DENIED',
      message: writes
        ? `agy ended the turn without an answer after headless mode ${deniedSummary(s.deniedActions)}${retriedAfterDenial ? ', including on automatic retry inside the workspace' : ''}; headless agy ends its turn on a denial.`
        : retriedAfterDenial
          ? `agy ended the turn without an answer after headless mode ${deniedSummary(s.deniedActions)}, including on automatic retry (headless mode cannot ask for permission).`
          : `agy ended the turn without an answer after headless mode ${deniedSummary(s.deniedActions)} (headless mode cannot ask for permission).`,
      retryable: false,
    };
  }
  // The first turn ended without an answer and the profile check took the rest of its time.
  const recoveryTimeoutNote = "the turn's time ran out while CoAgent8 verified its agy profile, so no automatic recovery turn started.";
  if (timedOutBeforeRecovery && !sessionMismatch) {
    error = firstTurnError
      ? { ...firstTurnError, message: `${firstTurnError.message} Also, ${recoveryTimeoutNote}` }
      : {
          code: 'TIMEOUT',
          message: `agy ended the turn without an answer after headless mode ${deniedSummary(s.deniedActions)}, and ${recoveryTimeoutNote}`,
          retryable: true,
        };
  }
  const effectiveSessionId =
    sessionMismatch || error?.code === 'SESSION_INVALID' || error?.code === 'PROTOCOL_ERROR'
      ? null
      : (s.nativeSessionId ?? expectedSessionId ?? null);
  // Only a UUID names a marker file: the identifier comes from agy's output.
  if (effectiveSessionId && UUID.test(effectiveSessionId) && usesAgyProfile()) recordProfileConversation(effectiveSessionId);

  const status =
    !sessionMismatch && timedOutBeforeRecovery && !firstTurnError
      ? 'timed_out'
      : !sessionMismatch && (processResult.status === 'cancelled' || processResult.status === 'timed_out')
        ? processResult.status
        : error
          ? 'failed'
          : 'completed';
  return {
    ...s,
    nativeSessionId: effectiveSessionId,
    // agy may omit the model from `init`; then the requested model is the best known.
    model: s.model ?? targetModel,
    status,
    isError: status !== 'completed',
    error,
    errorDetail: error?.message,
    threadId: effectiveSessionId,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    // The collector owns the answer; the runner's bounded stdout copy of the event stream is diagnostic.
    truncated: s.truncated || error?.code === 'BUFFER_LIMIT',
    // Only a reported stop is evidence; agy otherwise reports no stop reason.
    lengthLimited: outputLimited ? true : undefined,
    continuationAvailable:
      !!(effectiveSessionId || native) &&
      !['PROTOCOL_ERROR', 'SESSION_INVALID', 'CLI_NOT_FOUND', 'SANDBOX_UNAVAILABLE'].includes(error?.code || ''),
  };
}

/**
 * Groups `agy models` lines (`<id>\t<display name>`) by effort: agy lists
 * `gemini-3.8-flash-high` and accepts `--model gemini-3.8-flash --effort high`, but rejects
 * `gemini-3.8-flash` without an effort.
 */
export function parseAgyModels(stdout: string): CatalogModel[] {
  const suffix = new RegExp(`^(.+)-(${VALID_REASONING_EFFORTS.join('|')})$`);
  const models: CatalogModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const modelId = line.split('\t')[0].trim();
    if (!line.includes('\t') || !isValidModelIdentifier(modelId)) continue;
    const match = suffix.exec(modelId);
    if (!match) {
      models.push({ id: modelId, efforts: [] });
      continue;
    }
    const group = models.find(model => model.id === match[1] && model.effortRequired);
    if (group) group.efforts.push(match[2]);
    else models.push({ id: match[1], efforts: [match[2]], effortRequired: true });
  }
  return models;
}

/** Reads the models agy offers with `agy models`, which makes no model call (about 2 s). */
export async function listModels(_probe?: AdapterProbeResult, context?: BackendReadContext): Promise<ModelCatalog | undefined> {
  checkPreflight(context, 'Gemini model list');
  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch {
    // Without a resolvable agy there is no catalog; the turn itself reports why agy cannot run.
    return undefined;
  }
  const res = await runCommand(resolved.command, [...resolved.argsPrefix, 'models'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_MODEL_LIST_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    // The catalog is the account's; `agy models` loads no turn tools and creates no profile (#224).
    env: userAgyEnvironment(),
  });
  checkPostRun(res, context, 'Gemini model list');
  if (res.status !== 'completed' || res.exitCode !== 0 || !res.stdout) return undefined;
  const models = parseAgyModels(res.stdout);
  return models.length ? { models, source: 'agy models' } : undefined;
}

/** Names of the enabled servers in an `agy mcp list` table (`NAME  TYPE  STATUS  COMMAND/URL`). */
export function parseAgyMcpList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim().split(/\s{2,}/))
    .filter(columns => columns.length >= 3 && columns[0] !== 'NAME' && columns[2] === 'enabled')
    .map(columns => columns[0]);
}

/**
 * Names of every server in an `agy mcp list` table, a disabled one included: a turn can enable it.
 * @returns The names; undefined unless the output is agy's empty message
 * (`No MCP servers configured.`) or a table under a `NAME ... STATUS` header (agy 1.3.1 to 1.5.18).
 */
export function configuredAgyMcpServers(stdout: string): string[] | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 1 && lines[0] === 'No MCP servers configured.') return [];
  const header = lines[0]?.split(/\s{2,}/);
  if (!header || header[0] !== 'NAME' || header[2] !== 'STATUS') return undefined;
  const rows = lines.slice(1).map(line => line.split(/\s{2,}/));
  if (rows.some(columns => columns.length < 3)) return undefined;
  return rows.map(columns => columns[0]);
}

/**
 * Names of the plugins in `agy plugin list --json` (agy 1.5.18: an array of `{ name, enabled }`).
 * @returns The names, or undefined when the output is not that array.
 */
export function parseAgyPluginList(stdout: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const names = parsed.map(entry => asRecord(entry)?.name);
  // An entry without a name is a shape CoAgent8 does not know, not a missing plugin.
  return names.every((plugin): plugin is string => typeof plugin === 'string' && plugin.length > 0) ? names : undefined;
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Plugin directories agy discovers in the global customization root and keeps enabled: a
 * `plugins` entry in `config.json` wins, otherwise the plugin's own `disabled` declaration.
 * @param configDir - agy's `config` directory; the one a CoAgent8 call loads by default.
 * @param options - `includeDisabled` also names disabled plugins, which a turn could enable (#224).
 * @remarks `agy plugin list` names only imported plugins, not discovered ones (agy 1.3.1).
 */
export function listAgyPlugins(configDir = path.join(agyConfigDir(), 'config'), options: { includeDisabled?: boolean } = {}): string[] {
  const root = path.join(configDir, 'plugins');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const settings = asRecord(readJsonObject(path.join(configDir, 'config.json'))?.plugins);
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(dir => {
      const manifest = readJsonObject(path.join(root, dir, 'plugin.json'));
      if (!manifest) return false;
      if (options.includeDisabled) return true;
      const enabled = asRecord(settings?.[dir])?.enabled;
      return typeof enabled === 'boolean' ? enabled : manifest.disabled !== true;
    });
}

/**
 * Reads the MCP servers and plugins agy would offer its model in a CoAgent8 turn, without a
 * model call; doctor names them (CUR-002).
 * @returns The inherited tools, or undefined when agy cannot be run or read.
 * @remarks On Windows this is the check that gates every turn ({@link usesAgyProfile}):
 * anything listed there refuses agy turns. A profile that does not exist yet has nothing
 * configured and is not created here ({@link agyProfileExists}). Elsewhere they are the user's own servers and
 * plugins, which turns offer and CoAgent8 cannot disable.
 */
export async function inheritedTools(context?: BackendReadContext): Promise<InheritedTools | undefined> {
  checkPreflight(context, 'Gemini inherited tools read');
  let resolved: ReturnType<typeof resolveCliCommand>;
  try {
    resolved = resolveCliCommand(configuredBackendCommand('agy'));
  } catch {
    return undefined;
  }
  if (usesAgyProfile()) {
    // Not created yet: nothing is configured there, and a read must not create it or start agy
    // against it; the first turn creates and verifies it (#224). Doctor reports that state.
    if (!agyProfileExists()) return { mcpServers: [], plugins: [] };
    // In this process's directory: a turn's own directory is checked again before it starts.
    const read = await readAgyProfileContents(
      resolved,
      boundReadTimeout(context, DEFAULT_MODEL_LIST_TIMEOUT_MS),
      effectiveAbortSignal(context),
      process.cwd(),
    );
    const status = 'contents' in read ? 'completed' : read.aborted ? 'cancelled' : 'failed';
    checkPostRun({ status }, context, 'Gemini inherited tools read');
    return 'contents' in read ? read.contents : undefined;
  }
  const res = await runCommand(resolved.command, [...resolved.argsPrefix, 'mcp', 'list'], {
    timeoutMs: boundReadTimeout(context, DEFAULT_MODEL_LIST_TIMEOUT_MS),
    abortSignal: effectiveAbortSignal(context),
    env: userAgyEnvironment(),
  });
  checkPostRun(res, context, 'Gemini inherited tools read');
  if (res.status !== 'completed' || res.exitCode !== 0) return undefined;
  let plugins: string[];
  try {
    plugins = listAgyPlugins();
  } catch {
    return undefined;
  }
  return { mcpServers: parseAgyMcpList(res.stdout), plugins };
}

// `resolveModelAndEffort` drops a model's effort suffix when an effort is passed separately.
export const agyAdapter: CliAdapter = {
  id,
  name,
  effortReplacesModelSuffix: true,
  probe,
  execute,
  inspectQuota,
  listModels,
  inheritedTools,
};
export default agyAdapter;
