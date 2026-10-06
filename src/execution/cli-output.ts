/**
 * Normalization of raw CLI output before it is gated, redacted and returned.
 *
 * @remarks
 * CLI tools emit color codes, terminal cursor movement sequences, and npm update notifications.
 * `stripAnsi` removes escape sequences, and `stripCliBanners` cleans box-drawing banners while
 * carefully preserving Markdown tables (distinguished by ASCII `|` borders).
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

/**
 * Strips CLI update banners, npm notices, and box-drawing update warnings.
 *
 * Preserves Markdown table rows (starting and ending with ASCII `|`) and State Envelope headers.
 *
 * @param text - Output text to filter.
 * @returns Filtered text with update banners removed.
 */
export function stripCliBanners(text: string): string {
  const lines = text.split(/\r?\n/);
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    // Preserve Markdown table rows (which start and end with ASCII '|')
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) return true;
    // Never strip lines containing finding markers or state envelope headers
    if (/\[P[123]\]/i.test(trimmed) || /^(?:REVIEW|SNAPSHOT|COVERAGE|VERDICT|CHECKS|END_REVIEW|Problem|Evidence|Fix):/i.test(trimmed)) return true;
    if (/^npm (notice|WARN update)/i.test(trimmed)) return false;
    if (/^[┌└╭╰][─═]+[┐┘╮╯]$/.test(trimmed)) return false;
    // Match only Unicode box-drawing side borders, NOT standard ASCII '|'
    if (/^[╭│╰┌└║][─\s\S]*[╮│╯┐┘║]$/.test(trimmed) && /(update|version|available|npm|new\s+release)/i.test(trimmed)) return false;
    if (/^Run `?npm (i|install) -g .*`? to update/i.test(trimmed)) return false;
    if (/^A new version of .* is available/i.test(trimmed)) return false;
    return true;
  });
  return filtered.join('\n');
}

/**
 * Strips ANSI codes, banners, and trims whitespace deterministically.
 *
 * @param text - Raw output string from subprocess.
 * @returns Normalized output.
 */
export function cleanCliOutput(text: string): string {
  if (!text) return '';
  return stripCliBanners(stripAnsi(text)).trim();
}
