/**
 * Guard against recursive turns (`CUR-002`).
 *
 * @remarks
 * agy starts every MCP server of the user's agy configuration in its turns, so a CoAgent8
 * registered in agy would start another CoAgent8 that can start another backend turn, and
 * so on. Every backend turn runs with {@link NESTED_TURN_ENV} set; agy passes its environment
 * to the MCP servers it starts (measured with agy 1.3.1), so a CoAgent8 started inside a turn
 * sees the variable and refuses to run another one. Diagnostics and history stay available.
 * Codex and Claude turns start no inherited MCP server at all.
 *
 * @packageDocumentation
 */
import { ToolError } from '../conversation.js';

/** Set in the environment of every backend turn this server starts. */
export const NESTED_TURN_ENV = 'COAGENT8_NESTED_TURN';

/**
 * Environment for a backend turn: the given one with {@link NESTED_TURN_ENV} set.
 * @param base - Environment to extend; defaults to this process's.
 */
export function turnEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, [NESTED_TURN_ENV]: '1' };
}

/**
 * Refuses a turn when this server was started from inside a backend turn.
 * @throws `POLICY_DENIED` when {@link NESTED_TURN_ENV} is set in this process's environment.
 */
export function assertNotNestedTurn(env: NodeJS.ProcessEnv = process.env): void {
  if (env[NESTED_TURN_ENV] === '1') {
    throw new ToolError('POLICY_DENIED', 'CoAgent8 was started by a backend inside a CoAgent8 turn (a CoAgent8 registration in that CLI) and does not start another turn from there.');
  }
}
