/**
 * MCP progress notifications bridge and debouncing.
 *
 * @packageDocumentation
 */

import { redactDiagnostic } from '../security/redaction.js';

export type ProgressCallback = ((message: string | { message?: string }, progress?: number | null, total?: number | null) => void) & {
  close: () => void;
};

export function createProgressReporter(
  server: {
    notification: (notification: {
      method: string;
      params: { progressToken: string | number; progress: number; message: string };
    }) => Promise<unknown>;
  },
  progressToken?: string | number | null,
  minIntervalMs = 500,
): ProgressCallback {
  let count = 0,
    closed = false,
    lastSent = 0;
  let lastMessage = '';
  let pendingTimeout: NodeJS.Timeout | undefined;
  let pendingMessage: string | null = null;

  // Receives only messages `report` has already redacted.
  function dispatch(clean: string) {
    if (closed || progressToken == null) return;
    if (clean === lastMessage) return;
    lastSent = Date.now();
    lastMessage = clean;
    void server
      .notification({
        method: 'notifications/progress',
        params: { progressToken, progress: ++count, message: clean },
      })
      .catch(() => {});
  }

  const report = ((info: string | { message?: string }) => {
    if (closed || progressToken == null) return;
    const raw = typeof info === 'string' ? info : info.message || '';
    if (!raw) return;
    // The single redaction of a progress message, where it leaves for the client.
    const msg = redactDiagnostic(raw, 512).trim();
    if (!msg) return;
    const now = Date.now();
    const elapsed = now - lastSent;

    if (elapsed >= minIntervalMs) {
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = undefined;
      }
      pendingMessage = null;
      dispatch(msg);
    } else {
      pendingMessage = msg;
      if (!pendingTimeout) {
        pendingTimeout = setTimeout(
          () => {
            pendingTimeout = undefined;
            if (!closed && pendingMessage) {
              const next = pendingMessage;
              pendingMessage = null;
              dispatch(next);
            }
          },
          Math.max(10, minIntervalMs - elapsed),
        );
      }
    }
  }) as ProgressCallback;

  report.close = () => {
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = undefined;
    }
    if (!closed && pendingMessage) {
      const finalMsg = pendingMessage;
      pendingMessage = null;
      dispatch(finalMsg);
    }
    closed = true;
  };

  return report;
}
