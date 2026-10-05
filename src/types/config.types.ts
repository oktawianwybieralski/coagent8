import type { ProviderId } from './conversation.types.js';
/** Compatibility alias: config defaults may select a strategy, sessions may not. */
export type BackendId = ProviderId | 'smart_quota';
export type RoutingStrategy = 'fixed' | 'smart_quota';

export type ToolProfile = 'canonical' | 'compact';

export interface RoutingConfig {
  strategy: RoutingStrategy;
  allowedBackends: ProviderId[];
}

export interface CoAgentConfig {
  schemaVersion: number;
  defaultBackend: BackendId | null;
  routing: RoutingConfig;
  toolProfile?: ToolProfile;
}
