import { codexAdapter } from './codex/adapter.js';
import { agyAdapter } from './agy/adapter.js';
import { claudeAdapter } from './claude/adapter.js';
import type { CliAdapter } from './types.js';
import type { ProviderId } from '../conversation.js';
export const adapterRegistry: Record<ProviderId, CliAdapter> = { codex: codexAdapter, agy: agyAdapter, claude: claudeAdapter };
