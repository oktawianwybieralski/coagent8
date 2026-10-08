const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PROVIDERS, ERROR_CODES, ToolError, BufferLimitError, errorCodeOf } = require('../src/contracts/index.ts');
const { isValidModelIdentifier } = require('../src/contracts/models.ts');
const { validEventIdentifier } = require('../src/contracts/conversation.ts');
const { withFileLock, atomicWrite, LockTimeoutError, inProcessLocks } = require('../src/storage/lock.ts');
const { readBoundedFile, readBoundedFileSync } = require('../src/storage/read.ts');
const { canonicalPath } = require('../src/workspace/identity.ts');
const { resolveWorkspacePath, chooseWorkspace } = require('../src/workspace/workspace.ts');
const { truncateToByteLength, createLineDecoder } = require('../src/execution/runtime/stream.ts');

test('S1 contracts: provider, error, event, and model syntax contracts', () => {
  assert.deepEqual(PROVIDERS, ['codex', 'agy', 'claude']);
  assert.ok(ERROR_CODES.includes('CLI_NOT_FOUND'));
  assert.ok(ERROR_CODES.includes('BUFFER_LIMIT'));

  const toolErr = new ToolError('PRICE_LIMIT', 'price too high');
  assert.equal(toolErr.name, 'ToolError');
  assert.equal(toolErr.code, 'PRICE_LIMIT');
  assert.equal(errorCodeOf(toolErr), 'PRICE_LIMIT');
  assert.equal(errorCodeOf(new Error('generic')), 'PROCESS_ERROR');

  const bufErr = new BufferLimitError('limit exceeded');
  assert.equal(bufErr.name, 'BufferLimitError');
  assert.equal(bufErr.code, 'BUFFER_LIMIT');

  assert.equal(isValidModelIdentifier('gpt-4o'), true);
  assert.equal(isValidModelIdentifier('-flag'), false);
  assert.equal(isValidModelIdentifier('with space'), false);

  assert.equal(validEventIdentifier('evt_123'), true);
  assert.equal(validEventIdentifier(''), false);
});

test('S1 storage: atomicWrite, withFileLock, and bounded reads in storage/', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-storage-s1-'));
  try {
    const file = path.join(tempDir, 'data.txt');
    await atomicWrite(file, 'hello storage');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello storage');

    // Bounded reads
    assert.equal(readBoundedFileSync(file, 1024), 'hello storage');
    assert.equal(await readBoundedFile(file, 1024), 'hello storage');

    assert.throws(() => readBoundedFileSync(file, 4), /exceeds the byte limit/);
    await assert.rejects(readBoundedFile(file, 4), /exceeds the byte limit/);

    // Lock
    let inside = false;
    await withFileLock(file, async () => {
      inside = true;
    });
    assert.equal(inside, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('S1 workspace: canonicalPath and chooseWorkspace in workspace/', () => {
  const norm = canonicalPath(process.cwd());
  assert.ok(norm.length > 0);
  assert.equal(canonicalPath(''), '');
  assert.equal(canonicalPath(null), '');

  const chosen = chooseWorkspace(null, null, process.cwd());
  assert.equal(chosen.path, path.resolve(process.cwd()));
  assert.equal(chosen.source, 'server_directory');

  const resolved = resolveWorkspacePath(process.cwd());
  assert.equal(resolved, path.resolve(process.cwd()));
});

test('S1 runtime stream: truncateToByteLength and createLineDecoder in execution/runtime/', () => {
  assert.equal(truncateToByteLength('hello world', 5, '..'), 'hel..');
  assert.equal(truncateToByteLength('short', 10), 'short');

  const lines = [];
  const decoder = createLineDecoder(l => lines.push(l));
  decoder.push(Buffer.from('line1\nline2\r\n'));
  decoder.finish();
  assert.deepEqual(lines, ['line1', 'line2']);
});

