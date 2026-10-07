const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

/**
 * Stages the VS Code extension in `.artifacts/vscode`.
 * @param serverRoot - The extracted npm package; the MCP server bundle, its notices,
 * the logo and the license are taken from it, never from the working tree.
 * @returns The staging directory.
 */
async function buildExtension(serverRoot) {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, '.artifacts/vscode');
  const manifest = require('../extensions/vscode/package.json');
  const server = JSON.parse(fs.readFileSync(path.join(serverRoot, 'package.json'), 'utf8'));
  if (manifest.version !== server.version) throw new Error('VS Code and MCP source versions must match.');
  // VSIX requires a numeric version; the package command marks development builds as pre-release.
  const version = server.version.split('-')[0];
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('VSIX requires a numeric major.minor.patch version.');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.join(output, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ ...manifest, version }, null, 2) + '\n');
  for (const name of ['index.cjs', 'index.cjs.map', 'THIRD_PARTY_NOTICES.txt']) {
    fs.copyFileSync(path.join(serverRoot, 'dist', name), path.join(output, 'dist', name));
  }
  fs.copyFileSync(path.join(serverRoot, 'assets/logo.png'), path.join(output, 'assets/logo.png'));
  fs.copyFileSync(path.join(serverRoot, 'LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'extensions/vscode/README.md'), path.join(output, 'README.md'));
  await esbuild.build({
    entryPoints: [path.join(root, 'extensions/vscode/src/extension.ts')],
    outfile: path.join(output, 'dist/extension.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
  });
  console.log(`VS Code development extension staged for MCP ${server.version}.`);
  return output;
}

module.exports = { buildExtension };
