const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { readTarball, extractPackage, verifyPlugin } = require('../scripts/package-artifacts.cjs');

test('package.json has zero omniagent entry in bin and clean coagent8 release metadata', () => {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, 'coagent8');
  assert.equal(typeof pkg.bin, 'object');
  assert.equal(pkg.bin.omniagent, undefined, 'omniagent entry must be completely purged from bin');
  assert.equal(pkg.bin.coagent8, './dist/index.cjs', 'coagent8 binary must point to dist/index.cjs');
});

test('package-lock.json has zero omniagent entry in bin', () => {
  const lockPath = path.resolve(__dirname, '..', 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  const rootPkg = lock.packages && lock.packages[''];
  if (rootPkg && rootPkg.bin) {
    assert.equal(rootPkg.bin.omniagent, undefined, 'omniagent entry must be purged from package-lock.json bin');
  }
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
