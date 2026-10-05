import { codexAdapter } from './codex.adapter.js';
import { geminiAdapter } from './gemini.adapter.js';
import { claudeAdapter } from './claude.adapter.js';
import type { CliAdapter, ProviderId } from '../types/adapter.types.js';
export const adapterRegistry: Record<ProviderId, CliAdapter> = { codex: codexAdapter, gemini: geminiAdapter, claude: claudeAdapter };
