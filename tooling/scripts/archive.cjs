// Bounded readers for the archives CoAgent8 ships: the npm tarball (gzipped ustar)
// and the VS Code VSIX (ZIP). Packaging and native acceptance both read candidates
// through this module. Malformed input fails with an error instead of looping,
// reading out of bounds or inflating without limit.
const fs = require('node:fs');
const zlib = require('node:zlib');

/** Default ceiling for an archive file and for its decompressed contents (64 MiB). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

function readBoundedArchive(file, maxBytes) {
  const size = fs.statSync(file).size;
  if (size > maxBytes) throw new Error(`Archive ${file} exceeds ${maxBytes} bytes.`);
  return fs.readFileSync(file);
}

function inflateBounded(inflate, data, maxBytes, file) {
  try {
    return inflate(data, { maxOutputLength: maxBytes });
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
      throw new Error(`Archive ${file} expands beyond ${maxBytes} bytes.`);
    }
    throw new Error(`Archive ${file} cannot be decompressed: ${error.message}`);
  }
}

function parseOctal(field, label, file) {
  const value = field.replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]+$/.test(value)) throw new Error(`Tar header in ${file} has an invalid ${label} field.`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Tar header in ${file} has an out-of-range ${label} field.`);
  return parsed;
}

/**
 * Reads a gzipped ustar archive into a map of entry path to file contents; PAX path records are honored.
 * @param file - Archive path.
 * @param options - `maxBytes` bounds both the archive file and its decompressed size.
 * @returns Map of entry paths to contents.
 */
function readTarball(file, { maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  const data = inflateBounded(zlib.gunzipSync, readBoundedArchive(file, maxBytes), maxBytes, file);
  const entries = new Map();
  let offset = 0,
    paxPath = null;
  const text = (start, length) => data.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (parseOctal(data.toString('latin1', offset + 148, offset + 156), 'checksum', file) !== sum) {
      throw new Error(`Tar header checksum mismatch in ${file} at offset ${offset}.`);
    }
    const size = parseOctal(data.toString('latin1', offset + 124, offset + 136), 'size', file);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(offset + 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100));
    if (offset + 512 + size > data.length) throw new Error(`Tar entry ${name} in ${file} is truncated.`);
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

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf, file) {
  // The record is 22 bytes followed by a comment of at most 65535 bytes.
  for (let at = buf.length - 22; at >= Math.max(0, buf.length - 22 - 0xffff); at--) {
    if (buf.readUInt32LE(at) === EOCD_SIGNATURE && at + 22 + buf.readUInt16LE(at + 20) === buf.length) return at;
  }
  throw new Error(`Invalid ZIP archive ${file}: end of central directory not found.`);
}

/**
 * Reads one stored or deflated entry of a ZIP archive and verifies its size and CRC-32.
 * @param file - Archive path.
 * @param name - Exact entry name.
 * @param options - `maxBytes` bounds the archive file and the entry's uncompressed size.
 * @returns The entry contents, or null when the archive has no such entry.
 * @remarks ZIP64, multi-disk and encrypted archives are rejected; a VSIX uses none of them.
 */
function readZipEntry(file, name, { maxBytes = MAX_ARCHIVE_BYTES } = {}) {
  const buf = readBoundedArchive(file, maxBytes);
  if (buf.length < 22) throw new Error(`Invalid ZIP archive ${file}: too short.`);
  const eocd = findEndOfCentralDirectory(buf, file);
  const disk = buf.readUInt16LE(eocd + 4),
    cdDisk = buf.readUInt16LE(eocd + 6);
  const diskEntries = buf.readUInt16LE(eocd + 8),
    count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12),
    cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error(`ZIP64 archive ${file} is not supported.`);
  if (disk !== 0 || cdDisk !== 0 || diskEntries !== count) throw new Error(`Multi-disk ZIP archive ${file} is not supported.`);
  if (cdOffset + cdSize > eocd) throw new Error(`Invalid ZIP archive ${file}: central directory out of bounds.`);

  let match = null;
  for (let i = 0, pos = cdOffset; i < count; i++) {
    if (pos + 46 > cdOffset + cdSize || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new Error(`Invalid ZIP archive ${file}: malformed central directory entry ${i}.`);
    }
    const next = pos + 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    if (next > cdOffset + cdSize) throw new Error(`Invalid ZIP archive ${file}: central directory entry ${i} out of bounds.`);
    const entryName = buf.toString('utf8', pos + 46, pos + 46 + buf.readUInt16LE(pos + 28));
    if (entryName === name) {
      if (match) throw new Error(`ZIP archive ${file} contains ${name} more than once.`);
      match = {
        flags: buf.readUInt16LE(pos + 8),
        method: buf.readUInt16LE(pos + 10),
        crc: buf.readUInt32LE(pos + 16),
        compressedSize: buf.readUInt32LE(pos + 20),
        size: buf.readUInt32LE(pos + 24),
        localOffset: buf.readUInt32LE(pos + 42),
      };
    }
    pos = next;
  }
  if (!match) return null;

  if (match.flags & 0x1) throw new Error(`Encrypted ZIP entry ${name} in ${file} is not supported.`);
  if (match.compressedSize === 0xffffffff || match.size === 0xffffffff || match.localOffset === 0xffffffff) {
    throw new Error(`ZIP64 entry ${name} in ${file} is not supported.`);
  }
  if (match.size > maxBytes) throw new Error(`ZIP entry ${name} in ${file} exceeds ${maxBytes} bytes.`);
  const local = match.localOffset;
  if (local + 30 > cdOffset || buf.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`Invalid ZIP archive ${file}: malformed local header for ${name}.`);
  }
  const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  if (dataStart + match.compressedSize > cdOffset) throw new Error(`ZIP entry ${name} in ${file} is out of bounds.`);
  const raw = buf.subarray(dataStart, dataStart + match.compressedSize);

  let content;
  if (match.method === 0) content = Buffer.from(raw);
  else if (match.method === 8) content = inflateBounded(zlib.inflateRawSync, raw, maxBytes, file);
  else throw new Error(`ZIP entry ${name} in ${file} uses unsupported compression method ${match.method}.`);
  if (content.length !== match.size) throw new Error(`ZIP entry ${name} in ${file} has the wrong size.`);
  if (zlib.crc32(content) !== match.crc) throw new Error(`ZIP entry ${name} in ${file} fails its CRC-32 check.`);
  return content;
}

module.exports = { MAX_ARCHIVE_BYTES, readTarball, readZipEntry };
