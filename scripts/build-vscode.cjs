const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

/**
 * Checks that the extension and the server carry the same version, which the VSIX uses unchanged.
 * VS Code accepts only a numeric major.minor.patch and offers Restart Extensions after an update
 * only when that number changes, so npm, the VSIX and the Git tag share one version (REPO-003).
 * @param manifestVersion - The version in `extensions/vscode/package.json`.
 * @param serverVersion - The version of the packed npm package.
 * @returns The VSIX version.
 */
function extensionVersion(manifestVersion, serverVersion) {
  if (manifestVersion !== serverVersion) throw new Error('VS Code and MCP source versions must match.');
  if (!/^\d+\.\d+\.\d+$/.test(serverVersion)) throw new Error(`VSIX requires a numeric major.minor.patch version, not ${serverVersion}.`);
  return serverVersion;
}

/**
 * Whether a version is a preview: every version below 1.0.0 (REPO-003). A preview is a VS Code
 * pre-release, a GitHub pre-release and npm `next`; the release workflows apply the same rule.
 * @param version - A numeric major.minor.patch version.
 */
function isPreview(version) {
  return /^0\.\d+\.\d+$/.test(version);
}

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
  extensionVersion(manifest.version, server.version);
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.join(output, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  fs.cpSync(path.join(root, 'extensions/vscode/schemas'), path.join(output, 'schemas'), { recursive: true });
  // Setup installs these skills with each registration; they come from the package like the runtime.
  fs.cpSync(path.join(serverRoot, 'skills'), path.join(output, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const name of ['index.cjs', 'setup.cjs', 'THIRD_PARTY_NOTICES.txt']) {
    fs.copyFileSync(path.join(serverRoot, 'dist', name), path.join(output, 'dist', name));
  }
  fs.copyFileSync(path.join(serverRoot, 'assets/logo.png'), path.join(output, 'assets/logo.png'));
  fs.copyFileSync(path.join(serverRoot, 'LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'extensions/vscode/README.md'), path.join(output, 'README.md'));
  fs.copyFileSync(path.join(root, 'CHANGELOG.md'), path.join(output, 'CHANGELOG.md'));
  await esbuild.build({
    entryPoints: [path.join(root, 'extensions/vscode/src/extension.ts')],
    outfile: path.join(output, 'dist/extension.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
  });
  // `vscode:uninstall` runs without the VS Code API, so the hook is a separate bundle.
  await esbuild.build({
    entryPoints: [path.join(root, 'extensions/vscode/src/uninstall.ts')],
    outfile: path.join(output, 'dist/uninstall.cjs'),
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', mainFields: ['module', 'main'],
  });
  console.log(`VS Code development extension staged for MCP ${server.version}.`);
  return output;
}

module.exports = { buildExtension, extensionVersion, isPreview };
