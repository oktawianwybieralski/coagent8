/**
 * Codex model catalog from `codex app-server` `model/list` (Codex CLI 0.160), which makes
 * no model call: about 0.1 to 0.7 s on Windows (2026-10-07).
 *
 * @packageDocumentation
 */
import { BRAND } from '../../constants.js';
import { runCommand, type StdinChannel } from '../../execution/process.js';
import type { CatalogModel, ModelCatalog } from '../types.js';
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
