const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readTarball, readZipEntry } = require('../scripts/archive.cjs');
const { createSyntheticArtifacts } = require('../tooling/acceptance/artifacts.cjs');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-archive-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

function tarHeader(name, sizeField) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(sizeField, 124, 'ascii');
  header[156] = 48;
  header.write('ustar\0', 257, 'ascii');
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return header;
}

test('readTarball rejects negative sizes, bad checksums and truncated entries instead of looping', t => {
  const dir = scratch(t);
  const write = (name, blocks) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
    return file;
  };
  assert.throws(() => readTarball(write('negative.tgz', [tarHeader('a', '-1000\0'), Buffer.alloc(1024)])), /invalid size field/);
  const corrupt = tarHeader('a', '00000000000\0');
  corrupt[0] = 0x62;
  assert.throws(() => readTarball(write('checksum.tgz', [corrupt, Buffer.alloc(1024)])), /checksum mismatch/);
  assert.throws(() => readTarball(write('truncated.tgz', [tarHeader('a', '00000004000\0'), Buffer.alloc(512)])), /truncated/);
  assert.throws(() => readTarball(write('big.tgz', [Buffer.alloc(4096)]), { maxBytes: 1024 }), /expands beyond/);
});

test('readZipEntry verifies structure, compression method and CRC-32', t => {
  const dir = scratch(t);
  const { vsixPath } = createSyntheticArtifacts(dir, '0.6.1');
  assert.equal(JSON.parse(readZipEntry(vsixPath, 'extension/package.json')).version, '0.6.1');
  assert.equal(readZipEntry(vsixPath, 'missing.json'), null);

  const original = fs.readFileSync(vsixPath);
  const variant = (name, mutate) => {
    const buf = Buffer.from(original);
    mutate(buf);
    const file = path.join(dir, name);
    fs.writeFileSync(file, buf);
    return file;
  };
  const eocd = original.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const cd = original.readUInt32LE(eocd + 16);
  assert.throws(() => readZipEntry(variant('method.vsix', b => b.writeUInt16LE(99, cd + 10)), 'extension/package.json'), /unsupported compression method 99/);
  assert.throws(() => readZipEntry(variant('crc.vsix', b => b.writeUInt32LE(0, cd + 16)), 'extension/package.json'), /CRC-32/);
  assert.throws(() => readZipEntry(variant('zip64.vsix', b => b.writeUInt32LE(0xffffffff, eocd + 16)), 'extension/package.json'), /ZIP64/);
  assert.throws(() => readZipEntry(variant('bounds.vsix', b => b.writeUInt32LE(eocd + 100, eocd + 16)), 'extension/package.json'), /out of bounds/);
  assert.throws(() => readZipEntry(variant('noeocd.vsix', b => b.writeUInt32LE(0, eocd)), 'extension/package.json'), /end of central directory/);
});
