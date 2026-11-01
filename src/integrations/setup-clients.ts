/** Recognized optional native-host setup IDs; not a runtime client allowlist. */
export const SETUP_CLIENTS = ['codex', 'claude', 'agy'] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];
