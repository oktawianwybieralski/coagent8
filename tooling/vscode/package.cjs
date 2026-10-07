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
  baseContentUrl: 'https://github.com/oktawianwybieralski/coagent8/blob/release/v1.0.0',
  baseImagesUrl: 'https://raw.githubusercontent.com/oktawianwybieralski/coagent8/release/v1.0.0',
  preRelease: version.includes('-'),
}).then(() => {
  if (!fs.existsSync(artifact)) throw new Error('VSIX was not generated.');
  console.log(`VSIX ready: ${artifact}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
