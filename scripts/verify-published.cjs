#!/usr/bin/env node
// Verifies that the published packages are the release files (RELEASE-001f): the npm
// registry's `dist.shasum` and `dist.integrity` for the version equal the release tarball's
// SHA-1 and SHA-512, the `next` dist-tag points at the version (rule 02 section 4), and the
// VSIX the Marketplace serves for the version is byte-identical to the release VSIX.
// Usage: node scripts/verify-published.cjs --tag vX.Y.Z --dir <folder with the release files>
// [--skip-marketplace]. It reads public endpoints only and needs no credentials.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const PACKAGE = 'coagent8';
const REGISTRY = 'https://registry.npmjs.org';
const MARKETPLACE = 'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/okidev/vsextensions/coagent8-mcp';
/** Largest download accepted from the Marketplace, in bytes. */
const MAX_VSIX_BYTES = 64 * 1024 * 1024;

/** SHA-1 hex, SHA-512 integrity and SHA-256 hex of a buffer. */
function digests(buffer) {
  return {
    sha1: createHash('sha1').update(buffer).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/**
 * Compares the release files with what the registries serve.
 * @param expected - `version`, the tarball's digests and, unless skipped, the VSIX SHA-256.
 * @param observed - The registry `dist`, the `dist-tags` and the Marketplace VSIX SHA-256.
 * @returns One message per mismatch; empty when everything matches.
 */
function compare(expected, observed) {
  const problems = [];
  if (!observed.dist) problems.push(`npm has no ${PACKAGE}@${expected.version}.`);
  else {
    if (observed.dist.shasum !== expected.tarball.sha1) problems.push(`npm dist.shasum ${observed.dist.shasum} is not the release tarball's ${expected.tarball.sha1}.`);
    if (observed.dist.integrity !== expected.tarball.integrity) problems.push('npm dist.integrity differs from the release tarball.');
  }
  if (observed.distTags?.next !== expected.version) problems.push(`npm dist-tag next is ${observed.distTags?.next ?? 'missing'}, not ${expected.version}.`);
  if (expected.vsixSha256 !== undefined && observed.vsixSha256 !== expected.vsixSha256) {
    problems.push(`the Marketplace VSIX ${observed.vsixSha256 ?? 'is missing'}${observed.vsixSha256 ? ' differs from' : ', expected'} the release VSIX ${expected.vsixSha256}.`);
  }
  return problems;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  return response.json();
}

async function fetchVsixSha256(version) {
  const response = await fetch(`${MARKETPLACE}/${version}/vspackage`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`The Marketplace answered ${response.status} for ${version}.`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_VSIX_BYTES) throw new Error(`The Marketplace VSIX is ${declared} bytes, above the limit.`);
  return sha256OfBoundedStream(response.body, MAX_VSIX_BYTES);
}

/**
 * SHA-256 of a byte stream, read chunk by chunk.
 * @throws When the stream exceeds `limit` bytes; the stream is cancelled first, so a missing
 * or understated Content-Length cannot make the download unbounded.
 */
async function sha256OfBoundedStream(stream, limit) {
  const hash = createHash('sha256');
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`The Marketplace VSIX exceeds the ${limit}-byte limit.`);
    }
    hash.update(value);
  }
  return hash.digest('hex');
}

function parseArgs(argv) {
  const options = { skipMarketplace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-marketplace') options.skipMarketplace = true;
    else if ((argv[i] === '--tag' || argv[i] === '--dir') && argv[i + 1]) options[argv[i].slice(2)] = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(options.tag || '')) throw new Error('Pass --tag vX.Y.Z.');
  if (!options.dir) throw new Error('Pass --dir <folder with the release files>.');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const version = options.tag.slice(1);
  const read = name => {
    const file = path.join(options.dir, name);
    if (!fs.existsSync(file)) throw new Error(`${name} is not in ${options.dir}.`);
    return fs.readFileSync(file);
  };
  const expected = {
    version,
    tarball: digests(read(`${PACKAGE}-${version}.tgz`)),
    ...(options.skipMarketplace ? {} : { vsixSha256: digests(read(`coagent8-mcp-${version}.vsix`)).sha256 }),
  };
  const manifest = await fetchJson(`${REGISTRY}/${PACKAGE}/${version}`);
  const observed = {
    dist: manifest?.dist,
    distTags: await fetchJson(`${REGISTRY}/-/package/${PACKAGE}/dist-tags`),
    ...(options.skipMarketplace ? {} : { vsixSha256: await fetchVsixSha256(version) }),
  };
  const problems = compare(expected, observed);
  if (problems.length) throw new Error(problems.join('\n'));
  console.log(`${PACKAGE}@${version}: npm shasum, integrity and next match the release tarball${options.skipMarketplace ? '' : '; the Marketplace VSIX matches the release VSIX'}.`);
}

if (require.main === module) {
  main().catch(error => {
    for (const line of error.message.split('\n')) console.error(`::error::${line}`);
    process.exitCode = 1;
  });
}

module.exports = { digests, compare, parseArgs, sha256OfBoundedStream, main };
