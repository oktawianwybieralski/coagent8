/** Shared minimum version for the restricted execution profile and model metadata. */
/**
 * `--restricted` needs 2.1.248 and `--permission-prompts` 2.1.259 (Claude Code CLI
 * reference). A local `/usage` in print mode, which reports the model in `system/init`
 * without a model turn, was verified live on 2.1.289; the bridge needs it to know which
 * model an unlisted name runs before consent. The stream-json `initialize` model list with
 * `resolvedModel` (2.1.197 and later) was verified live on 2.1.294.
 */
export const MIN_CLAUDE_VERSION: readonly [number, number, number] = [2, 1, 289];
/** Returns whether a `claude --version` output meets {@link MIN_CLAUDE_VERSION}. */
export function supportsClaudeVersion(versionOutput: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(versionOutput.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (actual[i] !== MIN_CLAUDE_VERSION[i]) return actual[i] > MIN_CLAUDE_VERSION[i];
  return true;
}
