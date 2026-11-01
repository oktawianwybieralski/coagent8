/**
 * Metadata-only onboarding checks; never submits a prompt or starts sign-in.
 * @packageDocumentation
 */
import { runCommand } from '../execution/process.js';
import type { CliCommand } from '../execution/cli-resolver.js';
import type { SetupClient } from './setup-clients.js';
import { object, withStdioRpc } from './rpc.js';
import { MIN_CLAUDE_VERSION, supportsClaudeVersion } from '../backends/claude/version.js';

/** CLI evidence is distinct from runtime/host calls and per-turn sandbox verification. */
export interface CliReadiness {
  version: string | null;
  compatibility: 'supported' | 'unsupported' | 'unknown';
  authentication: 'authenticated' | 'unauthenticated' | 'unknown';
  ready: boolean;
  diagnostic: string;
}

/** Reads bounded version/help/login metadata; token validity still needs a user-authorized turn. */
export async function inspectCli(client: SetupClient, cli: CliCommand, env: NodeJS.ProcessEnv, cwd: string): Promise<CliReadiness> {
  const result: CliReadiness = { version: null, compatibility: 'unknown', authentication: 'unknown', ready: false, diagnostic: '' };
  // agy's background updater opens a console window on Windows; probes never need it.
  const probeEnv = client === 'agy' ? { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : env;
  const command = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    runCommand(cli.command, [...cli.argsPrefix, ...args], {
      env: { ...probeEnv, ...extraEnv },
      cwd,
      timeoutMs: 10_000,
      maxBufferBytes: 64 * 1024,
    });
  const version = await command(['--version']);
  if (version.exitCode !== 0 || version.status !== 'completed') {
    result.diagnostic = 'CLI version probe failed or timed out. Check the executable and retry.';
    return result;
  }
  const parsedVersion = /\b(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?/.exec(version.stdout);
  result.version = parsedVersion?.[0] ?? null;
  const help = await command(['--help']);
  if (help.exitCode !== 0 || help.status !== 'completed' || !parsedVersion) {
    result.diagnostic = 'Version/help could not establish CLI compatibility.';
    return result;
  }
  const flags =
    client === 'codex'
      ? ['app-server', 'sandbox']
      : client === 'claude'
        ? [
            '--restricted',
            '--tools',
            '--permission-mode',
            '--permission-prompts',
            '--strict-mcp-config',
            '--mcp-config',
            '--output-format',
            '--input-format',
            '--no-session-persistence',
          ]
        : ['--sandbox', '--output-format', '--input-format', '--conversation'];
  const recentClaude = client !== 'claude' || supportsClaudeVersion(parsedVersion[0]);
  // agy 1.3.1 prints its help to stderr with exit code 0; Codex and Claude use stdout.
  const helpText = `${help.stdout}\n${help.stderr}`;
  result.compatibility = recentClaude && flags.every(flag => helpText.includes(flag)) ? 'supported' : 'unsupported';
  if (result.compatibility !== 'supported') {
    result.diagnostic = `Required CLI controls are missing (Claude requires ${MIN_CLAUDE_VERSION.join('.')}+). Update explicitly and retry.`;
    return result;
  }
  if (client === 'codex') {
    try {
      await withStdioRpc(
        cli.command,
        [...cli.argsPrefix, 'app-server', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'],
        async rpc => {
          object(await rpc.request('initialize', { clientInfo: { name: 'coagent8_onboarding', version: '1' } }));
          rpc.notify('initialized');
        },
        { env, cwd, timeoutMs: 10_000 },
      );
    } catch {
      result.compatibility = 'unknown';
      result.diagnostic = 'Codex app-server handshake failed. Check the CLI and retry.';
      return result;
    }
    const auth = await command(['login', 'status']);
    // Only the CLI's documented status is evidence; arbitrary successful output is not.
    const status = auth.stdout + '\n' + auth.stderr;
    if (auth.status === 'completed' && auth.exitCode === 0 && /logged in (?:using|with)/i.test(status))
      result.authentication = 'authenticated';
    else if (/not logged in/i.test(status)) result.authentication = 'unauthenticated';
  } else if (client === 'claude') {
    const auth = await command(['auth', 'status', '--json']);
    try {
      const data = object(JSON.parse(auth.stdout));
      if (auth.status === 'completed' && auth.exitCode === 0 && data.loggedIn === true) result.authentication = 'authenticated';
      else if (auth.exitCode === 1 && data.loggedIn === false) result.authentication = 'unauthenticated';
    } catch {
      /* Unsupported or malformed metadata leaves authentication unknown. */
    }
  } else {
    // agy has no status subcommand. `AGY_CLI_CDE_AUTH_ACTION=check` is the silent check the
    // Google Antigravity extension runs (exit 0 when signed in); it starts no prompt or login,
    // unlike `-p /usage`, which falls back to interactive sign-in. Only its own messages count:
    // other failures, such as a network error while refreshing a token, stay unknown.
    const auth = await command([], { AGY_CLI_CDE_AUTH_ACTION: 'check' });
    const status = auth.stdout + '\n' + auth.stderr;
    if (auth.status === 'completed' && auth.exitCode === 0 && /^Already authenticated as /m.test(status))
      result.authentication = 'authenticated';
    // A nonzero exit is `failed`; a timeout or launch error has no exit code and stays unknown.
    else if (
      auth.status === 'failed' &&
      typeof auth.exitCode === 'number' &&
      auth.exitCode !== 0 &&
      /not (?:authenticated|signed in|logged in)/i.test(status)
    )
      result.authentication = 'unauthenticated';
  }
  result.ready = result.compatibility === 'supported' && result.authentication === 'authenticated';
  result.diagnostic = result.ready
    ? 'CLI controls and local sign-in verified; per-turn sandbox and token validity remain execution checks.'
    : `Sign-in ${result.authentication}; use ${client === 'codex' ? 'codex login' : client === 'claude' ? 'claude auth login' : 'agy'} explicitly, then refresh.`;
  return result;
}
