import os from 'node:os';
import path from 'node:path';
export function getDataDir(): string {
  return path.resolve(process.env.coagent8_DIR || path.join(os.homedir(), '.coagent8'));
}
export function hasExplicitDataDir(): boolean { return !!process.env.coagent8_DIR; }
