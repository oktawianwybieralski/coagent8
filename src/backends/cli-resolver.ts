import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readBoundedFileSync } from '../execution/stream.js';
export interface CliCommand { command: string; argsPrefix: string[]; source: 'native' | 'node' | 'npm-shim' }
export class CliResolutionError extends Error {
  readonly code: 'CLI_NOT_FOUND' | 'CLI_UNSUPPORTED';
  constructor(code: 'CLI_NOT_FOUND' | 'CLI_UNSUPPORTED', message: string) {
    super(message);
    this.code = code;
  }
}
function extractEntrypoints(content: string, dir: string, extPattern: RegExp): string[] {
  const list: string[] = [];
  for (const m of content.matchAll(/(?:"(?:%dp0%|%~dp0)([^"\r\n]+)"|(?:%dp0%|%~dp0)([^\s"\r\n]+))/gi)) {
    const raw = (m[1] || m[2] || '').trim();
    if (extPattern.test(raw)) {
      const clean = raw.replace(/\\/g, '/').replace(/^\/+/, '');
      list.push(path.resolve(dir, clean));
    }
  }
  for (const m of content.matchAll(/(?:"([a-zA-Z]:[\\/][^"\r\n]+|\/[^"\r\n]+)"|([a-zA-Z]:[\\/][^\s"\r\n]+|\/[^\s"\r\n]+))/gi)) {
    const raw = (m[1] || m[2] || '').trim();
    if (extPattern.test(raw)) {
      list.push(path.resolve(raw));
    }
  }
  return [...new Set(list)].filter(p => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
}
function extractNativeArgsPrefix(content: string, exePath: string): string[] {
  const exeBase = path.basename(exePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(?:rem|::|@?echo)\b/i.test(line)) continue;
    let remainder: string | null = null;
    const quoted = new RegExp(`"[^"]*\\\\?${exeBase}"\\s*(.*)`, 'i').exec(line);
    if (quoted) {
      remainder = quoted[1];
    } else {
      const unquoted = new RegExp(`(?:\\S*\\\\)?${exeBase}\\s*(.*)`, 'i').exec(line);
      if (unquoted) {
        remainder = unquoted[1];
      }
    }
    if (remainder != null) {
      const parts = remainder.split(/%\*/);
      const beforeForward = parts[0].trim();
      const afterForward = (parts[1] || '').trim();

      if (afterForward) {
        const nonRedir = afterForward.replace(/(?:[0-9]*>>?(?:&[0-9]+|\s*[\w.-]+)|<[\w.-]+)/g, '').trim();
        if (nonRedir.length > 0) {
          throw new CliResolutionError('CLI_UNSUPPORTED', `Unsupported Windows shim: arguments after %* ('${nonRedir}') are not supported.`);
        }
      }

      if (!beforeForward) return [];

      let expanded = beforeForward;
      if (/%[a-zA-Z0-9_]+%/.test(expanded)) {
        expanded = expanded.replace(/%([a-zA-Z0-9_]+)%/g, (_, name) => {
          const val = process.env[name] || process.env[name.toUpperCase()] || process.env[name.toLowerCase()];
          if (val !== undefined) return val;
          throw new CliResolutionError('CLI_UNSUPPORTED', `Unsupported Windows shim with unresolvable environment variable: %${name}%.`);
        });
      }

      const args: string[] = [];
      const regex = /--?[a-zA-Z0-9_-]+="[^"]*"|"[^"]*"|\S+/g;
      for (const m of expanded.matchAll(regex)) {
        let tok = m[0];
        if (tok.startsWith('"') && tok.endsWith('"') && tok.length >= 2) {
          tok = tok.slice(1, -1);
        } else if (tok.includes('="') && tok.endsWith('"')) {
          const eqIdx = tok.indexOf('="');
          tok = tok.slice(0, eqIdx + 1) + tok.slice(eqIdx + 2, -1);
        }
        args.push(tok);
      }
      return args;
    }
  }
  return [];
}
function resolveShim(file: string, nodePath: string): CliCommand {
  let content: string;
  try { content = readBoundedFileSync(file, 64 * 1024); }
  catch { throw new CliResolutionError('CLI_UNSUPPORTED', 'Windows npm shim exceeds the byte limit or cannot be read.'); }
  const dir = path.dirname(file);
  const jsEntrypoints = extractEntrypoints(content, dir, /\.(?:js|cjs|mjs)$/i);
  if (jsEntrypoints.length === 1) {
    return { command: nodePath, argsPrefix: [jsEntrypoints[0]], source: 'npm-shim' };
  }
  const exeEntrypoints = extractEntrypoints(content, dir, /\.exe$/i);
  // Strictly exclude node.exe from being a native launcher if the JS entrypoint was missing
  const targetExes = exeEntrypoints.filter(p => path.basename(p).toLowerCase() !== 'node.exe');
  if (targetExes.length === 1) {
    const argsPrefix = extractNativeArgsPrefix(content, targetExes[0]);
    return { command: targetExes[0], argsPrefix, source: 'native' };
  }
  throw new CliResolutionError('CLI_UNSUPPORTED', 'Unsupported Windows shim: expected an existing npm JavaScript or native executable entrypoint.');
}

interface CachedResolution {
  result: CliCommand;
  expiresAt: number;
}

const cliCache = new Map<string, CachedResolution>();
const CLI_CACHE_TTL_MS = 60_000;
const MAX_CLI_CACHE_ENTRIES = 128;

/**
 * Resolves the newest usable Claude binary bundled with a local VS Code extension.
 * @param home - Local profile root; no remote or arbitrary extension roots are searched.
 * @param env - Resolution environment for the selected executable.
 * @returns A shell-free command, or null when no bundled executable is usable.
 * @remarks Candidates are read on each fallback so updates do not pin a removed version.
 */
export function resolveBundledClaude(home = os.homedir(), env = process.env): CliCommand | null {
  const candidates: { file: string; version: number[] }[] = [];
  for (const profile of ['.vscode', '.vscode-insiders']) {
    const dir = path.join(home, profile, 'extensions');
    let names: string[];
    try { names = fs.readdirSync(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new CliResolutionError('CLI_UNSUPPORTED', 'Claude extension directory is unreadable.');
    }
    for (const name of names) {
      const match = /^anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(name);
      if (!match) continue;
      const file = path.join(dir, name, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) candidates.push({ file, version: match.slice(1).map(Number) });
    }
  }
  candidates.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  for (const candidate of candidates) {
    try { return resolveCliCommand(candidate.file, { env }); }
    catch (error) {
      if (!(error instanceof CliResolutionError)) throw error;
      // An older installed version may be executable while the newest is unusable.
    }
  }
  return null;
}

/**
 * Clears the internal CLI path resolution cache.
 * Useful for tests or after modifying environment execution paths.
 */
export function clearCliResolverCache(): void {
  cliCache.clear();
}

export function resolveCliCommand(command: string, options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; cwd?: string; nodePath?: string } = {}): CliCommand {
  const nodePath = options.nodePath || process.execPath;
  const env = options.env || process.env, platform = options.platform || process.platform, cwd = options.cwd || process.cwd();
  if (!command || command.includes('\0')) throw new CliResolutionError('CLI_NOT_FOUND', 'CLI command is empty or invalid.');
  const explicit = path.isAbsolute(command) || /[\\/]/.test(command);
  const envPath = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] || '';
  const pathext = env.PATHEXT || '';
  const cacheKey = `${platform}\0${nodePath}\0${cwd}\0${command}\0${envPath}\0${pathext}`;

  const now = Date.now();
  const cached = cliCache.get(cacheKey);
  if (cached) {
    if (now < cached.expiresAt) {
      cliCache.delete(cacheKey);
      cliCache.set(cacheKey, cached);
      return { command: cached.result.command, argsPrefix: [...cached.result.argsPrefix], source: cached.result.source };
    }
    cliCache.delete(cacheKey);
  }

  const dirs = explicit ? [''] : envPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32' && !path.extname(command)
    ? [...(pathext || '.COM;.EXE;.BAT;.CMD').split(';').map(s => s.toLowerCase()), ''] : [''];
  for (const dir of dirs) for (const extension of extensions) {
    const file = explicit ? path.resolve(cwd, command + extension) : path.resolve(dir.replace(/^"|"$/g, ''), command + extension);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const realFile = fs.realpathSync(file);
    let resolved: CliCommand;
    if (/\.(js|cjs|mjs)$/i.test(realFile)) resolved = { command: nodePath, argsPrefix: [realFile], source: 'node' };
    else if (/\.(cmd|bat)$/i.test(file)) resolved = resolveShim(file, nodePath);
    else if (platform !== 'win32') {
      try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; }
      resolved = { command: file, argsPrefix: [], source: 'native' };
    } else {
      resolved = { command: file, argsPrefix: [], source: 'native' };
    }

    cliCache.delete(cacheKey);
    if (cliCache.size >= MAX_CLI_CACHE_ENTRIES) {
      const oldestKey = cliCache.keys().next().value;
      if (oldestKey) cliCache.delete(oldestKey);
    }
    cliCache.set(cacheKey, {
      result: { command: resolved.command, argsPrefix: [...resolved.argsPrefix], source: resolved.source },
      expiresAt: now + CLI_CACHE_TTL_MS,
    });
    return resolved;
  }
  if (!explicit && command === 'claude') {
    const home = platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir();
    const bundled = resolveBundledClaude(home, env);
    if (bundled) return bundled;
  }
  throw new CliResolutionError('CLI_NOT_FOUND', `CLI '${path.basename(command)}' is not installed or executable; configure its *_PATH or PATH.`);
}
