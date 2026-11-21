/**
 * The user's consent to run agents on the host without a sandbox (#211, owner decision 2026-11-21).
 *
 * @packageDocumentation
 */

import { loadConfig, saveConfig } from '../config.js';
import { ToolError } from '../contracts/error.js';

/** Asks the user once; absent when the client cannot show a form. */
export type HostConsentPrompt = (signal?: AbortSignal | null) => Promise<{ approved: boolean; declined?: boolean; unanswered?: boolean }>;

/** What a turn can do on the host, as the form and the refusal say it. */
export const HOST_EXECUTION_NOTICE =
  "Agents run on this computer with your account's rights, without a sandbox: they can read and change files, run commands and use the network.";

/**
 * Whether the user accepted host execution, in the configuration or for this process.
 * @throws The configuration error when the configuration cannot be read.
 */
export function hostExecutionAccepted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COAGENT8_HOST_EXECUTION === 'accepted') return true;
  // A configuration that cannot be read throws its own error: it is no missing consent.
  return loadConfig().hostExecution === 'accepted';
}

/**
 * Passes when the user accepted host execution, otherwise asks once and records the answer.
 * @param ask - The form, or undefined where none can be shown.
 * @param signal - Ends the wait for the form.
 * @throws `POLICY_DENIED` without consent; no turn starts.
 */
export async function ensureHostConsent(ask?: HostConsentPrompt, signal?: AbortSignal | null): Promise<void> {
  if (hostExecutionAccepted()) return;
  const how =
    'Set "hostExecution": "accepted" in the CoAgent8 configuration, or approve the form in a client that shows MCP forms. No model turn started.';
  if (!ask) throw new ToolError('POLICY_DENIED', `${HOST_EXECUTION_NOTICE} This needs your consent. ${how}`);
  const answer = await ask(signal);
  if (!answer.approved) {
    throw new ToolError(
      'POLICY_DENIED',
      answer.declined || answer.unanswered
        ? `The consent to run agents on this computer was not given; a client may decline without showing the form. ${how}`
        : `The consent to run agents on this computer was refused. ${how}`,
    );
  }
  await saveConfig({ hostExecution: 'accepted' });
}
