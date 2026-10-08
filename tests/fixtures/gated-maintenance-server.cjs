// Starts the stdio server with background maintenance held by a file gate, so a test can
// observe shutdown while maintenance is still running. Usage: node gated-maintenance-server.cjs <gate>
require('tsx/cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { serveStdio } = require(path.resolve(__dirname, '../../src/mcp/stdio-server.ts'));

const gate = process.argv[2];
async function gatedMaintenance() {
  await fs.writeFile(`${gate}.started`, 'started');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fs.access(`${gate}.release`); return; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (Date.now() > deadline) throw new Error('Maintenance gate was never released.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

serveStdio({ maintenance: gatedMaintenance }).catch(error => {
  process.stderr.write(`Fatal error: ${error.message}\n`);
  process.exit(1);
});
