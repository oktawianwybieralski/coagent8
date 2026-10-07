/**
 * Normalization of answer text before it is gated, redacted and returned.
 *
 * @remarks
 * Every backend returns its answer from JSON events, so CLI banners and npm notices
 * never reach it; only escape sequences are removed. Text that quotes a banner is
 * part of the answer and stays.
 *
 * @packageDocumentation
 */

/**
 * Deterministically strips ANSI escape sequences (colors, cursor movements, styles).
 *
 * @param text - Raw terminal text with ANSI codes.
 * @returns Clean text without ANSI sequences.
 */
export function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}
