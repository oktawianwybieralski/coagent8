const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { buildBundles } = require('../scripts/build.cjs');
const { readTarball, extractPackage, verifyPlugin } = require('../scripts/package-artifacts.cjs');

test('optional setup is a separate bundle and core startup excludes installation and JSONC modules', async () => {
  const root = path.resolve(__dirname, '..');
  assert.ok(fs.existsSync(path.join(root, 'dist/index.cjs')));
  assert.ok(fs.existsSync(path.join(root, 'dist/setup.cjs')));
  assert.ok(!fs.existsSync(path.join(root, 'dist/index.cjs.map')), 'core bundle must not emit a source map');
  assert.ok(!fs.existsSync(path.join(root, 'dist/setup.cjs.map')), 'setup bundle must not emit a source map');
  const { modules } = await buildBundles({ write: false });
  assert.ok(modules['index.cjs']?.length > 0, 'core bundle module list must be populated');
  assert.ok(!modules['index.cjs'].some(source => /integrations[\\/]|jsonc-parser/.test(source)), 'build module graph proves setup code is outside core');
  assert.ok(modules['setup.cjs']?.includes('src/integrations/setup-cli.ts'), 'setup bundle includes setup entrypoint');
  assert.ok(modules['setup.cjs']?.some(source => /jsonc-parser/.test(source)), 'setup bundle includes jsonc-parser');
});

test('package.json has zero omniagent entry in bin and clean coagent8 release metadata', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, 'coagent8');
  assert.equal(typeof pkg.bin, 'object');
  assert.equal(pkg.bin.omniagent, undefined, 'omniagent entry must be completely purged from bin');
  assert.equal(pkg.bin.coagent8, './dist/index.cjs', 'coagent8 binary must point to dist/index.cjs');
  assert.equal(pkg.dependencies, undefined, 'bundled packages belong in devDependencies, not dependencies');
  assert.equal(pkg.peerDependencies, undefined, 'package.json must declare no peerDependencies');
  assert.equal(pkg.optionalDependencies, undefined, 'package.json must declare no optionalDependencies');
});

test('package-lock.json has zero omniagent entry in bin', () => {
  const lockPath = path.resolve(__dirname, '..', 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  const rootPkg = lock.packages && lock.packages[''];
  assert.ok(rootPkg, 'package-lock.json must contain the root package entry');
  if (rootPkg.bin) {
    assert.equal(rootPkg.bin.omniagent, undefined, 'omniagent entry must be purged from package-lock.json bin');
  }
  assert.equal(rootPkg.dependencies, undefined, 'package-lock.json root entry must declare no runtime dependencies');
});

/** A gzipped ustar archive; `pax` entries carry their path in a PAX header, as npm writes long names. */
function tarball(entries) {
  const blocks = [];
  const header = (name, size, type) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0);
    block.write(size.toString(8).padStart(11, '0'), 124);
    block.write(type, 156);
    block.write('ustar\u000000', 257);
    return block;
  };
  const body = data => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  for (const { name, data, pax } of entries) {
    if (pax) {
      const record = ` path=${name}\n`;
      const line = Buffer.from(`${String(record.length + 3).padStart(3, '0')}${record}`);
      blocks.push(header('PaxHeader', line.length, 'x'), body(line));
    }
    blocks.push(header(pax ? 'package/truncated' : name, data.length, '0'), body(data));
  }
  return zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test('PACKAGE-001: the tarball reader extracts package/ entries, honors PAX paths and refuses escapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-tarball-'));
  try {
    const long = `package/${'nested/'.repeat(20)}file.txt`;
    const file = path.join(dir, 'pkg.tgz');
    fs.writeFileSync(file, tarball([{ name: 'package/dist/index.cjs', data: Buffer.from('bundle') }, { name: long, data: Buffer.from('deep'), pax: true }]));
    const entries = readTarball(file);
    assert.deepEqual([...entries.keys()], ['package/dist/index.cjs', long]);
    const target = path.join(dir, 'out');
    extractPackage(entries, target);
    assert.equal(fs.readFileSync(path.join(target, 'dist', 'index.cjs'), 'utf8'), 'bundle');
    assert.equal(fs.readFileSync(path.join(target, long.slice('package/'.length)), 'utf8'), 'deep');
    assert.throws(() => extractPackage(new Map([['package/../escape.txt', Buffer.from('x')]]), target), /escapes the target/);
    assert.throws(() => extractPackage(new Map([['other/file.txt', Buffer.from('x')]]), target), /outside package/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PACKAGE-001: the plugin check rejects a package whose manifests reference missing files', () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-plugin-'));
  try {
    for (const name of ['package.json', 'plugin.json', 'mcp.json', 'index.js']) fs.copyFileSync(path.join(root, name), path.join(dir, name));
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'index.cjs'), '');
    assert.throws(() => verifyPlugin(dir), /assets\/logo32\.png/, 'a missing plugin icon is reported');
    fs.mkdirSync(path.join(dir, 'assets'));
    for (const name of ['logo.png', 'logo32.png', 'logo-light.png']) fs.writeFileSync(path.join(dir, 'assets', name), '');
    assert.throws(() => verifyPlugin(dir), /assets\/logo32-light\.png/, 'a missing dark-theme plugin icon is reported');
    fs.writeFileSync(path.join(dir, 'assets/logo32-light.png'), '');
    verifyPlugin(dir);
    const plugin = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...plugin, version: '0.0.0' }));
    assert.throws(() => verifyPlugin(dir), /version/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the VSIX keeps the shared numeric version and every version below 1.0.0 is a preview', () => {
  const { extensionVersion, isPreview } = require('../scripts/build-vscode.cjs');
  assert.equal(extensionVersion('0.6.0', '0.6.0'), '0.6.0');
  assert.throws(() => extensionVersion('0.6.0', '0.7.0'), /must match/);
  assert.throws(() => extensionVersion('1.0.0-beta.2', '1.0.0-beta.2'), /numeric major\.minor\.patch version, not 1\.0\.0-beta\.2/, 'a pre-release suffix is refused, not stripped');
  assert.equal(isPreview('0.6.0'), true);
  assert.equal(isPreview('0.10.3'), true);
  assert.equal(isPreview('1.0.0'), false);
  assert.equal(isPreview('10.0.0'), false);
});

test('npm, plugin and VS Code manifests share one numeric version', () => {
  const root = path.resolve(__dirname, '..');
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const { version } = read('package.json');
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const lock = read('package-lock.json');
  for (const [name, actual] of [['package-lock.json', lock.version], ['package-lock.json packages[""]', lock.packages[''].version], ['plugin.json', read('plugin.json').version], ['extensions/vscode/package.json', read('extensions/vscode/package.json').version]]) {
    assert.equal(actual, version, `${name} carries the package version`);
  }
});
