const test = require('node:test');
const assert = require('node:assert/strict');
const { digests, compare, parseArgs } = require('../scripts/verify-published.cjs');

// RELEASE-001f: offline checks of the comparison; the registries are read by the workflow.
test('RELEASE-001f: published packages match only when every digest and next agree', () => {
  const tarball = digests(Buffer.from('tarball'));
  const vsix = digests(Buffer.from('vsix'));
  assert.match(tarball.sha1, /^[0-9a-f]{40}$/, 'npm dist.shasum is hex SHA-1');
  assert.match(vsix.sha256, /^[0-9a-f]{64}$/);
  assert.match(tarball.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
  const expected = { version: '0.7.0', tarball, vsixSha256: vsix.sha256 };
  const good = { dist: { shasum: tarball.sha1, integrity: tarball.integrity }, distTags: { next: '0.7.0', latest: '0.6.1' }, vsixSha256: vsix.sha256 };
  assert.deepEqual(compare(expected, good), [], '`latest` may still point at the earlier stable version');
  assert.deepEqual(compare(expected, { ...good, dist: undefined }), ['npm has no coagent8@0.7.0.']);
  assert.equal(compare(expected, { ...good, dist: { shasum: 'x', integrity: tarball.integrity } }).length, 1);
  assert.equal(compare(expected, { ...good, dist: { shasum: tarball.sha1, integrity: 'sha512-x' } }).length, 1);
  assert.deepEqual(compare(expected, { ...good, distTags: { next: '0.6.1' } }), ['npm dist-tag next is 0.6.1, not 0.7.0.']);
  assert.match(compare(expected, { ...good, vsixSha256: undefined })[0], /Marketplace VSIX is missing/);
  assert.match(compare(expected, { ...good, vsixSha256: 'other' })[0], /differs from the release VSIX/);
  const { vsixSha256, ...withoutVsix } = expected;
  assert.deepEqual(compare(withoutVsix, { ...good, vsixSha256: 'other' }), [], '--skip-marketplace ignores the VSIX');
});

test('RELEASE-001f: arguments need a numeric tag and the release folder', () => {
  assert.deepEqual(parseArgs(['--tag', 'v0.7.0', '--dir', 'release']), { skipMarketplace: false, tag: 'v0.7.0', dir: 'release' });
  assert.equal(parseArgs(['--tag', 'v0.7.0', '--dir', 'r', '--skip-marketplace']).skipMarketplace, true);
  assert.throws(() => parseArgs(['--tag', '0.7.0', '--dir', 'r']), /--tag vX\.Y\.Z/);
  assert.throws(() => parseArgs(['--tag', 'v0.7.0']), /--dir/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown or incomplete argument/);
});

test('RELEASE-001f: the Marketplace download is hashed chunk by chunk and cancelled above the limit', async () => {
  const { createHash } = require('node:crypto');
  const { sha256OfBoundedStream } = require('../scripts/verify-published.cjs');
  const streamOf = (...chunks) => new ReadableStream({ pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); } });
  const data = [Buffer.from('ab'), Buffer.from('cd')];
  assert.equal(await sha256OfBoundedStream(streamOf(...data), 4), createHash('sha256').update('abcd').digest('hex'));
  // No Content-Length is trusted: the running total stops the read.
  let cancelled = false;
  const endless = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } });
  await assert.rejects(sha256OfBoundedStream(endless, 10), /exceeds the 10-byte limit/);
  assert.equal(cancelled, true, 'the download is cancelled');
});
