require('tsx/cjs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveTestTargets } = require('./helpers/discovery.cjs');
const { terminateProcessTree } = require('../src/execution/process.ts');
const root = path.resolve(__dirname, '..');
// Bound simultaneous test files: each can own CLI process trees.
// Explicit CLI arguments follow the default and may override it for stress runs.
const { flags, testFiles } = resolveTestTargets(process.argv.slice(2), root);
const proc = spawn(process.execPath, [require.resolve('tsx/cli'), '--test', ...flags, ...testFiles], {
  cwd: root, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32',
});
let cancelling = false;
async function cancel() {
  if (cancelling) return;
  cancelling = true;
  await terminateProcessTree(proc);
  process.exitCode = 130;
}
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
proc.once('error', error => { console.error(error.message); process.exitCode = 1; });
proc.once('exit', async (code, signal) => {
  await terminateProcessTree(proc);
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  process.exitCode = cancelling ? 130 : code ?? (signal ? 1 : 0);
});
