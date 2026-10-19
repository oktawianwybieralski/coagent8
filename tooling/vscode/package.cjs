const path = require('node:path');
const fs = require('node:fs');
const { createVSIX } = require('@vscode/vsce');

const root = path.resolve(__dirname, '../..');
const { version } = require('../../package.json');
const artifact = path.join(root, '.artifacts', `coagent8-mcp-${version}.vsix`);
createVSIX({
  cwd: path.join(root, '.artifacts/vscode'),
  packagePath: artifact,
  dependencies: false,
  baseContentUrl: 'https://github.com/oktawianwybieralski/coagent8/blob/develop',
  baseImagesUrl: 'https://raw.githubusercontent.com/oktawianwybieralski/coagent8/develop',
  // The Marketplace normal channel, also below 1.0.0 (owner decision 2026-10-13, RELEASE-001c).
  preRelease: false,
}).then(() => {
  if (!fs.existsSync(artifact)) throw new Error('VSIX was not generated.');
  console.log(`VSIX ready: ${artifact}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
