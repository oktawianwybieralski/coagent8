const path = require('node:path');
const fs = require('node:fs');
const { createVSIX } = require('@vscode/vsce');

const root = path.resolve(__dirname, '../..');
const { version } = require('../../package.json');
const artifact = path.join(root, '.rc-artifacts', `coagent8-mcp-${version}.vsix`);
createVSIX({
  cwd: path.join(root, '.rc-artifacts/vscode'),
  packagePath: artifact,
  dependencies: false,
  preRelease: version.includes('-'),
}).then(() => {
  if (!fs.existsSync(artifact)) throw new Error('VSIX was not generated.');
  console.log(`VSIX ready: ${artifact}`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
