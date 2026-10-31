// Builds the distributable artifacts from the npm tarball (PACKAGE-001): the tarball
// itself, the Codex plugin directory and the VS Code extension staging directory.
// Nothing is taken from the working tree's dist/: every runtime file comes from the
// packed package, so the artifacts ship exactly what npm ships.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildExtension } = require('./build-vscode.cjs');
const { readTarball } = require('./archive.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.artifacts', 'package');
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

/** Writes the archive's `package/` entries below `target`, refusing paths that leave it. */
function extractPackage(entries, target) {
  fs.rmSync(target, { recursive: true, force: true });
  for (const [name, contents] of entries) {
    if (!name.startsWith('package/')) throw new Error(`Unexpected tar entry outside package/: ${name}`);
    const destination = path.resolve(target, name.slice('package/'.length));
    if (!destination.startsWith(target + path.sep)) throw new Error(`Tar entry escapes the target: ${name}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
}

/** Checks that the plugin manifests point at files the package contains. */
function verifyPlugin(dir) {
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const manifest = read('package.json'),
    plugin = read('plugin.json'),
    mcp = read('mcp.json');
  if (plugin.version !== manifest.version)
    throw new Error(`plugin.json version ${plugin.version} differs from the package ${manifest.version}.`);
  const server = mcp.mcpServers?.coagent8;
  const entry = server?.args?.[0];
  if (server?.command !== 'node' || entry !== '${PLUGIN_ROOT}/dist/index.cjs')
    throw new Error('mcp.json must start ${PLUGIN_ROOT}/dist/index.cjs with node.');
  for (const file of [
    entry.replace('${PLUGIN_ROOT}/', ''),
    ...Object.values(plugin.extensions['com.openai'].interface).filter(v => typeof v === 'string' && v.startsWith('./')),
    manifest.main,
    ...Object.values(manifest.bin),
  ]) {
    if (!fs.existsSync(path.join(dir, file))) throw new Error(`The plugin references ${file}, which the package does not contain.`);
  }
}

function main() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const pack = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`);
  const { filename } = JSON.parse(pack.stdout)[0];
  const tarball = path.join(output, filename);
  const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');

  const contents = path.join(output, 'contents');
  extractPackage(readTarball(tarball), contents);

  const plugin = path.join(root, '.artifacts', 'plugin', 'coagent8');
  fs.rmSync(path.dirname(plugin), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.cpSync(contents, plugin, { recursive: true });
  verifyPlugin(plugin);

  return buildExtension(contents).then(vscode => {
    const relative = file => path.relative(root, file).split(path.sep).join('/');
    const record = { tarball: relative(tarball), sha256, plugin: relative(plugin), vscode: relative(vscode) };
    fs.writeFileSync(path.join(output, 'artifacts.json'), JSON.stringify(record, null, 2) + '\n');
    console.log(`Artifacts from ${filename} (sha256 ${sha256}): ${record.plugin}, ${record.vscode}`);
  });
}

if (require.main === module) {
  Promise.resolve()
    .then(main)
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { extractPackage, verifyPlugin };
