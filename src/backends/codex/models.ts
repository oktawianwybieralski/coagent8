/**
 * Codex metadata from `codex app-server` without a thread or a model call: the model catalog
 * from `model/list` (Codex CLI 0.160, about 0.1 to 0.7 s on Windows, 2026-10-07) and the
 * account's rate-limit windows from `account/rateLimits/read` (0.7 s, 2026-10-08).
 *
 * @packageDocumentation
 */
import { BRAND } from '../../constants.js';
import { runCommand, type StdinChannel } from '../../execution/process.js';
import type { CatalogModel, ModelCatalog } from '../types.js';
import { summarizeQuotaWindows, type NativeQuota, type QuotaWindow } from '../quota.js';
import { codexAppServerArgs } from './app-server.js';

/** Upper bound for the catalog read; a slower read leaves the selection unchecked. */
const MODEL_LIST_TIMEOUT_MS = 10_000;
/** Pages read at most; the 0.160 catalog fits in one. */
const MAX_PAGES = 5;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reads the visible models of one `model/list` page.
 * @param acceptedEfforts - Efforts the adapter passes on; others (such as `ultra`) are not offered.
 * @returns The models, and the cursor of the next page when there is one.
 */
export function parseCodexModelPage(result: unknown, acceptedEfforts: readonly string[]): { models: CatalogModel[]; nextCursor: string | null } {
  const page = record(result);
  const data = Array.isArray(page?.data) ? page.data : [];
  const models = data.map(record).filter((entry): entry is Record<string, unknown> => entry !== null && entry.hidden !== true && typeof entry.id === 'string')
    .map(entry => ({
      id: entry.id as string,
      efforts: (Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [])
        .map(option => record(option)?.reasoningEffort).filter((effort): effort is string => typeof effort === 'string' && acceptedEfforts.includes(effort)),
      ...(entry.isDefault === true ? { isDefault: true } : {}),
    }));
  return { models, nextCursor: typeof page?.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null };
}

/**
 * Lists the models the signed-in Codex CLI offers.
 * @param command - The Codex executable.
 * @param acceptedEfforts - Efforts the adapter passes on.
 * @returns The catalog, or undefined when the server does not answer `model/list`.
 */
export async function listCodexModels(command: string, acceptedEfforts: readonly string[]): Promise<ModelCatalog | undefined> {
  const models: CatalogModel[] = [];
  let failed = false, pages = 0;
  let channel: StdinChannel | undefined;
  const request = (cursor: string | null) => channel?.send({ id: 2 + pages, method: 'model/list', params: cursor ? { cursor } : {} });
  // No thread is started; the overrides keep the server's defaults as read-only as a turn's.
  const result = await runCommand(command, codexAppServerArgs(), {
    timeoutMs: MODEL_LIST_TIMEOUT_MS, maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024,
    session: {
      start(opened) {
        channel = opened;
        opened.send({ id: 1, method: 'initialize', params: { clientInfo: { name: BRAND.PACKAGE_NAME, title: BRAND.NAME, version: BRAND.SERVER_VERSION } } });
      },
      interrupt(opened) { opened.close(); },
    },
    onStdoutLine(line) {
      let message: Record<string, unknown> | null;
      try { message = record(JSON.parse(line)); } catch { message = null; }
      // Notifications and server requests carry no answer to these two requests.
      if (!message || typeof message.id !== 'number' || typeof message.method === 'string') return;
      if (message.error !== undefined) { failed = true; channel?.close(); return; }
      if (message.id === 1) { channel?.send({ method: 'initialized' }); request(null); return; }
      const page = parseCodexModelPage(message.result, acceptedEfforts);
      models.push(...page.models);
      pages++;
      if (page.nextCursor && pages < MAX_PAGES) request(page.nextCursor);
      else channel?.close();
    },
  });
  if (failed || result.status !== 'completed' || !models.length) return undefined;
  return { models, source: 'codex app-server model/list' };
}

/** Names a window by its length: `5h`, `weekly`, else whole days, hours or minutes. */
function windowLabel(minutes: number): string {
  if (minutes === 10080) return 'weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/**
 * Reads an `account/rateLimits/read` result: every bucket of `rateLimitsByLimitId` (else the
 * single `rateLimits` view), each with its `primary` and `secondary` window, `usedPercent`
 * 0 to 100, `windowDurationMins` and `resetsAt` in Unix seconds.
 * @returns The bottleneck window and every measured window, or undefined when none is measured.
 */
export function parseCodexRateLimits(result: unknown): NativeQuota | undefined {
  const answer = record(result);
  const byId = record(answer?.rateLimitsByLimitId);
  const buckets = (byId ? Object.values(byId) : [answer?.rateLimits]).map(record).filter((bucket): bucket is Record<string, unknown> => bucket !== null);
  const windows: QuotaWindow[] = [];
  for (const bucket of buckets) {
    const limit = typeof bucket.limitId === 'string' ? bucket.limitId : 'codex';
    for (const slot of ['primary', 'secondary'] as const) {
      const window = record(bucket[slot]);
      const used = window?.usedPercent, minutes = window?.windowDurationMins, resets = window?.resetsAt;
      if (typeof used !== 'number' || !Number.isFinite(used) || typeof minutes !== 'number' || !(minutes > 0)) continue;
      windows.push({ id: `${limit}:${slot}`, name: typeof bucket.limitName === 'string' ? bucket.limitName : limit, window: windowLabel(minutes),
        remainingFraction: Math.max(0, Math.min(1, (100 - used) / 100)),
        resetTime: typeof resets === 'number' && Number.isFinite(resets) ? new Date(resets * 1000).toISOString() : '' });
    }
  }
  return summarizeQuotaWindows(windows);
}

/**
 * Reads the signed-in account's Codex rate-limit windows, without a thread or a model call.
 * @param command - The Codex executable.
 * @returns The measured quota, or undefined when the server answers with an error (for
 * example API-key sign-in without ChatGPT limits) or does not answer in time.
 */
export async function readCodexRateLimits(command: string): Promise<NativeQuota | undefined> {
  let channel: StdinChannel | undefined, quota: NativeQuota | undefined;
  const result = await runCommand(command, codexAppServerArgs(), {
    timeoutMs: MODEL_LIST_TIMEOUT_MS, maxBufferBytes: 512 * 1024, maxLineBytes: 512 * 1024,
    session: {
      start(opened) {
        channel = opened;
        opened.send({ id: 1, method: 'initialize', params: { clientInfo: { name: BRAND.PACKAGE_NAME, title: BRAND.NAME, version: BRAND.SERVER_VERSION } } });
      },
      interrupt(opened) { opened.close(); },
    },
    onStdoutLine(line) {
      let message: Record<string, unknown> | null;
      try { message = record(JSON.parse(line)); } catch { message = null; }
      if (!message || typeof message.id !== 'number' || typeof message.method === 'string') return;
      if (message.id === 1 && message.error === undefined) { channel?.send({ method: 'initialized' }); channel?.send({ id: 2, method: 'account/rateLimits/read' }); return; }
      if (message.id === 2 && message.error === undefined) quota = parseCodexRateLimits(message.result);
      channel?.close();
    },
  });
  return result.status === 'completed' ? quota : undefined;
}
