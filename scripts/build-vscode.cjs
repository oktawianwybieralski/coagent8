const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

async function buildExtension() {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '.rc-artifacts/vscode');
  const manifest = require('../extensions/vscode/package.json');
  const server = require('../package.json');
  if (manifest.version !== server.version) throw new Error('VS Code and MCP source versions must match.');
  // VSIX requires a numeric version; the package command marks development builds as pre-release.
  const version = server.version.split('-')[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VSIX requires a numeric major.minor.patch version.');
  if (output.startsWith(root) && output.includes('.rc-artifacts')) {
    fs.rmSync(output, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(output, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
  for (const name of ['index.cjs', 'index.cjs.map']) {
    fs.copyFileSync(path.join(root, 'dist', name), path.join(output, 'dist', name));
  }
  fs.copyFileSync(path.join(root, 'assets/logo.png'), path.join(output, 'assets/logo.png'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'extensions/vscode/README.md'), path.join(output, 'README.md'));
  await esbuild.build({
    entryPoints: [path.join(root, 'extensions/vscode/src/extension.ts')],
    outfile: path.join(output, 'dist/extension.cjs'),
    bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
  });
  console.log(`VS Code development extension built for MCP ${server.version}.`);
}

buildExtension().catch(error => { console.error(error.message); process.exitCode = 1; });
