/**
 * Artifact hash computation, package inspection, and fixture synthesis (ACCEPT-001a1).
 *
 * @remarks
 * Candidate archives are read through the shared bounded readers in
 * `scripts/archive.cjs`; this module adds package manifest checks and builds the
 * synthetic candidates a dry run installs.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { MAX_ARCHIVE_BYTES, readTarball, readZipEntry } = require('../../scripts/archive.cjs');

/**
 * Computes the SHA-256 hash of a file no larger than the archive bound.
 *
 * @param filePath - Path to the file.
 * @returns Hex-encoded SHA-256 digest.
 * @throws When the file exceeds {@link MAX_ARCHIVE_BYTES}; it is not read then.
 */
function sha256File(filePath) {
  if (fs.statSync(filePath).size > MAX_ARCHIVE_BYTES) {
    throw new Error(`${path.basename(filePath)} exceeds ${MAX_ARCHIVE_BYTES} bytes.`);
  }
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Parses a package manifest and requires a non-empty string version.
 *
 * @param content - Manifest bytes.
 * @param label - Manifest description for errors.
 * @returns The parsed manifest.
 */
function parseManifest(content, label) {
  let manifest;
  try {
    manifest = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof manifest.version !== 'string' || !manifest.version) {
    throw new Error(`${label} has no version.`);
  }
  return manifest;
}

/**
 * Reads and parses package.json from an npm tarball.
 *
 * @param tarballPath - Path to the .tgz package.
 * @returns Parsed package.json object.
 */
function readTarballPackageJson(tarballPath) {
  const entries = readTarball(tarballPath);
  const candidate = entries.get('package/package.json') || entries.get('package.json');
  if (!candidate) {
    throw new Error(`Tarball ${tarballPath} contains no package.json entry.`);
  }
  return parseManifest(candidate, `package.json in ${path.basename(tarballPath)}`);
}

/**
 * Reads and parses extension/package.json from a VS Code VSIX (ZIP archive).
 *
 * @param vsixPath - Path to the .vsix package.
 * @returns Parsed extension package.json object.
 */
function readVsixPackageJson(vsixPath) {
  const content = readZipEntry(vsixPath, 'extension/package.json');
  if (!content) {
    throw new Error(`VSIX ${vsixPath} contains no extension/package.json entry.`);
  }
  return parseManifest(content, `extension/package.json in ${path.basename(vsixPath)}`);
}

/**
 * Creates a minimal valid tarball archive in memory.
 *
 * @param files - Map of entry relative paths to content strings/buffers.
 * @returns Gzipped tarball Buffer.
 */
function buildTarGz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    // Name (0-99)
    header.write(name.slice(0, 100), 0, 'utf8');
    // Mode (100-107): 0644
    header.write('0000644\0', 100, 'ascii');
    // UID (108-115)
    header.write('0000000\0', 108, 'ascii');
    // GID (116-123)
    header.write('0000000\0', 116, 'ascii');
    // Size (124-135): octal string
    header.write(buf.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    // Mtime (136-147)
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
    // Type flag (156): '0' (regular file)
    header[156] = 48;
    // Magic (257-264): 'ustar\000'
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');

    // Checksum calculation (148-155) - treat 8 spaces during calculation
    header.fill(32, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

    blocks.push(header);
    blocks.push(buf);
    const remainder = buf.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  // Two 512-byte zero blocks at EOF
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/**
 * Creates a minimal valid ZIP archive in memory (compression method 0).
 *
 * @param files - Map of entry relative paths to content strings/buffers.
 * @returns ZIP Buffer.
 */
function buildZip(files) {
  const localHeaders = [];
  const cdEntries = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const localHeader = Buffer.alloc(30 + nameBuf.length);

    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4); // Version needed
    localHeader.writeUInt16LE(0, 6); // Flags
    localHeader.writeUInt16LE(0, 8); // Method: store (0)
    localHeader.writeUInt16LE(0, 10); // Time
    localHeader.writeUInt16LE(0, 12); // Date
    // CRC-32: compute crc
    const crc = zlib.crc32(data);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // Compressed size
    localHeader.writeUInt32LE(data.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // Name length
    localHeader.writeUInt16LE(0, 28); // Extra length
    nameBuf.copy(localHeader, 30);

    const cdEntry = Buffer.alloc(46 + nameBuf.length);
    cdEntry.writeUInt32LE(0x02014b50, 0); // Signature
    cdEntry.writeUInt16LE(20, 4); // Version made by
    cdEntry.writeUInt16LE(20, 6); // Version needed
    cdEntry.writeUInt16LE(0, 8); // Flags
    cdEntry.writeUInt16LE(0, 10); // Method
    cdEntry.writeUInt16LE(0, 12); // Time
    cdEntry.writeUInt16LE(0, 14); // Date
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(nameBuf.length, 28);
    cdEntry.writeUInt16LE(0, 30); // Extra length
    cdEntry.writeUInt16LE(0, 32); // Comment length
    cdEntry.writeUInt16LE(0, 34); // Disk start
    cdEntry.writeUInt16LE(0, 36); // Internal attr
    cdEntry.writeUInt32LE(0, 38); // External attr
    cdEntry.writeUInt32LE(offset, 42); // Local header offset
    nameBuf.copy(cdEntry, 46);

    localHeaders.push(localHeader);
    localHeaders.push(data);
    cdEntries.push(cdEntry);

    offset += localHeader.length + data.length;
  }

  const cdStart = offset;
  const cdData = Buffer.concat(cdEntries);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Disk number
  eocd.writeUInt16LE(0, 6); // Start disk
  eocd.writeUInt16LE(cdEntries.length, 8); // Disk entries
  eocd.writeUInt16LE(cdEntries.length, 10); // Total entries
  eocd.writeUInt32LE(cdData.length, 12); // CD size
  eocd.writeUInt32LE(cdStart, 16); // CD offset
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localHeaders, cdData, eocd]);
}

/**
 * Creates synthetic tarball and VSIX files for dry-run or unit testing.
 *
 * @param targetDir - Directory to place synthetic artifacts.
 * @param version - Version string to record in package manifests.
 * @returns Object with paths to created tarball and vsix.
 */
function createSyntheticArtifacts(targetDir, version = '0.6.1') {
  fs.mkdirSync(targetDir, { recursive: true });

  const pkgJson = JSON.stringify({
    name: 'coagent8',
    version,
    main: 'dist/index.cjs',
    bin: { coagent8: 'dist/index.cjs' },
  }, null, 2);

  // Minimal stub that answers `doctor --json` and `doctor`
  const stubRuntime = `
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('${version}');
  process.exit(0);
}
if (args[0] === 'doctor') {
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      status: 'operational',
      server_version: '${version}',
      operational: true,
      runtime_path: __filename,
      readiness: { codex: { status: 'ready' }, claude: { status: 'ready' }, agy: { status: 'ready' } }
    }));
  } else {
    console.log('CoAgent8 doctor: operational - version ${version}');
  }
  process.exit(0);
}
console.log('CoAgent8 synthetic CLI');
`;

  const tarballData = buildTarGz({
    'package/package.json': pkgJson,
    'package/dist/index.cjs': stubRuntime,
  });

  const tarballPath = path.join(targetDir, `coagent8-${version}.tgz`);
  fs.writeFileSync(tarballPath, tarballData);

  const vsixJson = JSON.stringify({
    name: 'coagent8-mcp',
    displayName: 'CoAgent8',
    version,
    publisher: 'okidev',
  }, null, 2);

  const vsixData = buildZip({
    'extension/package.json': vsixJson,
  });

  const vsixPath = path.join(targetDir, `coagent8-mcp-${version}.vsix`);
  fs.writeFileSync(vsixPath, vsixData);

  return { tarballPath, vsixPath };
}

module.exports = {
  sha256File,
  readTarballPackageJson,
  readVsixPackageJson,
  createSyntheticArtifacts,
  buildTarGz,
  buildZip,
};
