import fs from 'fs';
import path from 'node:path';

export const GOVERNED_TOP_TIER_MODELS = new Set(['astra', 'claude-3-opus', 'claude-3-opus-20240229', 'opus']);

export interface GovernanceCheckResult {
  isError: true;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Validates whether top-tier expensive reasoning models have explicit user confirmation.
 */
export function checkModelGovernance(modelName?: string | null, userConfirmed = false): GovernanceCheckResult | null {
  if (typeof modelName !== 'string') return null;

  const normalized = modelName.trim().toLowerCase();
  if (GOVERNED_TOP_TIER_MODELS.has(normalized) || /(?:^|[-_/])(?:astra|opus(?:plan)?)(?:$|[-_/\d\[])/.test(normalized) || normalized === 'best') {
    if (userConfirmed !== true) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `[GOVERNANCE ERROR] The selected model '${modelName}' is a top-tier deep reasoning model. ` +
              `Execution strictly requires explicit user confirmation (user_confirmed: true). ` +
              `Please prompt the user before initiating requests with this tier.`,
          },
        ],
      };
    }
  }
  return null;
}

/**
 * Resolves workspace path strictly; errors out if explicit path does not exist.
 */
export function resolveWorkspacePath(rawPath?: string | null): string {
  if (typeof rawPath === 'string' && rawPath.trim()) {
    const cleanPath = rawPath.trim();
    if (!fs.existsSync(cleanPath)) {
      throw new Error(`Validation Error: The specified workspace path does not exist: '${cleanPath}'`);
    }
    const stat = fs.statSync(cleanPath);
    if (!stat.isDirectory()) {
      throw new Error(`Validation Error: The specified workspace path is not a directory: '${cleanPath}'`);
    }
    return path.resolve(cleanPath);
  }
  return process.cwd();
}
