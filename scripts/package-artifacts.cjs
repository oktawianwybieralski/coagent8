// Builds the distributable artifacts from the npm tarball (PACKAGE-001): the tarball
// itself, the Codex plugin directory and the VS Code extension staging directory.
// Nothing is taken from the working tree's dist/: every runtime file comes from the
// packed package, so the artifacts ship exactly what npm ships.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildExtension } = require('./build-vscode.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.artifacts', 'package');
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

/** Reads a gzipped ustar archive into a map of entry path to file contents; PAX path records are honored. */
function readTarball(file) {
  const data = zlib.gunzipSync(fs.readFileSync(file));
  const entries = new Map();
  let offset = 0, paxPath = null;
  const text = (start, length) => data.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100));
    const body = data.subarray(offset + 512, offset + 512 + size);
    paxPath = null;
    if (type === 'x') {
      const record = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = record ? record[1] : null;
    } else if (type === '0' || type === '\0') {
      entries.set(name, Buffer.from(body));
    } else if (type !== '5' && type !== 'g') {
      throw new Error(`Unsupported tar entry type '${type}' for ${name}.`);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

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
  const manifest = read('package.json'), plugin = read('plugin.json'), mcp = read('mcp.json');
  if (plugin.version !== manifest.version) throw new Error(`plugin.json version ${plugin.version} differs from the package ${manifest.version}.`);
  const server = mcp.mcpServers?.coagent8;
  const entry = server?.args?.[0];
  if (server?.command !== 'node' || entry !== '${PLUGIN_ROOT}/dist/index.cjs') throw new Error('mcp.json must start ${PLUGIN_ROOT}/dist/index.cjs with node.');
  for (const file of [entry.replace('${PLUGIN_ROOT}/', ''), ...Object.values(plugin.extensions['com.openai'].interface).filter(v => typeof v === 'string' && v.startsWith('./')), manifest.main, ...Object.values(manifest.bin)]) {
    if (!fs.existsSync(path.join(dir, file))) throw new Error(`The plugin references ${file}, which the package does not contain.`);
  }
}

function main() {
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const pack = spawnSync(process.execPath, [npm, 'pack', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
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
  Promise.resolve().then(main).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { readTarball, extractPackage, verifyPlugin };
