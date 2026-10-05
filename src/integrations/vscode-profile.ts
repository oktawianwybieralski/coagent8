import fs from 'node:fs';
import path from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { readBoundedFileSync } from '../execution/stream.js';
import { object } from './rpc.js';

/**
 * Detects manual definitions in the active editor profile and workspace.
 * @param storagePath - VS Code's globalStorageUri path for this extension/profile.
 * @param folders - Workspace folder paths on the current extension host.
 * @returns True when a manual definition already owns CoAgent discovery.
 * @throws When an existing MCP file is malformed or unreadable; preserve it.
 * @remarks No other editor profile or machine is read or changed.
 */
export function hasManualVscodeRegistration(storagePath: string, folders: string[]): boolean {
  const files = [path.join(path.dirname(path.dirname(storagePath)), 'mcp.json'), ...folders.map(folder => path.join(folder, '.vscode', 'mcp.json'))];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const errors: ParseError[] = [];
    const value: unknown = parse(readBoundedFileSync(file, 512 * 1024), errors, { allowTrailingComma: true });
    if (errors.length) throw new Error('Existing VS Code MCP configuration is malformed; preserve it before setup.');
    const servers = object(value).servers;
    if (servers === undefined) continue;
    if (Object.entries(object(servers)).some(([name, entry]) => /coagent8/i.test(name) || /coagent8/i.test(JSON.stringify(entry)))) return true;
  }
  return false;
}
