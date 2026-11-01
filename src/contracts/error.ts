/**
 * Shared error contracts and error codes.
 *
 * @packageDocumentation
 */

export const ERROR_CODES = [
  'CLI_NOT_FOUND',
  'CLI_UNSUPPORTED',
  'AUTH_REQUIRED',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'SESSION_INVALID',
  'SESSION_BUSY',
  'ABORTED',
  'TIMEOUT',
  'SANDBOX_UNAVAILABLE',
  'PROTOCOL_ERROR',
  'BUFFER_LIMIT',
  'INPUT_LIMIT',
  'PROCESS_ERROR',
  'HISTORY_ERROR',
  'POLICY_DENIED',
  'PRICE_LIMIT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ExecutionError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

/**
 * A failure whose public error code is known where it is raised. Tool handlers report
 * `code` as is; any other thrown value is reported as `PROCESS_ERROR`.
 */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ToolError';
  }
}

/** Returns the public error code of a thrown value: its `ToolError` code, else `fallback`. */
export function errorCodeOf(err: unknown, fallback: ErrorCode = 'PROCESS_ERROR'): ErrorCode {
  return err instanceof ToolError ? err.code : fallback;
}

export class BufferLimitError extends ToolError {
  constructor(message: string) {
    super('BUFFER_LIMIT', message);
    this.name = 'BufferLimitError';
  }
}
