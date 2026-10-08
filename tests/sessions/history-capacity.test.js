const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-sessions-history-capacity-'));
process.env.coagent8_DIR = tempDir;

const { createHistoryWriter, getHistoryDir, deleteHistory } = require('../../src/sessions/history.ts');
const { createSession, closeSession } = require('../../src/sessions/session.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('History streaming flush skips directory scan and enforces TOTAL_LIMIT', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-history-scan-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.coagent8_DIR = dir;
  const sess = createSession('gemini', dir);
  const writer = createHistoryWriter(sess.sessionHandle, dir, 'gemini', 'turn-1');

  // First flush initializes and triggers retention check
  writer.accept({ type: 'turn_started' });
  await writer.flush();

  const historyDir = path.resolve(getHistoryDir());
  const fsp = require('node:fs/promises');
  let historyDirScans = 0;
  const origReaddir = fsp.readdir;
  fsp.readdir = async (...args) => {
    if (args[0] && path.resolve(String(args[0])) === historyDir) {
      historyDirScans++;
    }
    return origReaddir.apply(fsp, args);
  };

  try {
    // Perform multiple rapid streaming flushes (simulating 250ms streaming updates)
    for (let i = 1; i <= 5; i++) {
      writer.accept({ type: 'assistant_delta', messageId: 'msg-1', text: `chunk ${i} ` });
      await writer.flush();
    }
    // Zero directory scans of history directory during subsequent streaming flushes!
    assert.equal(historyDirScans, 0, `Expected 0 history directory scans during streaming flushes, got ${historyDirScans}`);
  } finally {
    fsp.readdir = origReaddir;
  }

  // Session close invokes pruneHistoryDirectory
  let closedHistoryDirScans = 0;
  fsp.readdir = async (...args) => {
    if (args[0] && path.resolve(String(args[0])) === historyDir) {
      closedHistoryDirScans++;
    }
    return origReaddir.apply(fsp, args);
  };
  try {
    await closeSession(sess.sessionHandle, dir);
    assert.ok(closedHistoryDirScans > 0, 'Expected history directory scan during session close');
  } finally {
    fsp.readdir = origReaddir;
  }
});

test('Concurrent writers strictly enforce 100MB TOTAL_LIMIT', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-history-concurrent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  process.env.coagent8_DIR = dir;
  const historyDir = getHistoryDir();
  fs.mkdirSync(historyDir, { recursive: true });

  const TOTAL_LIMIT = 100 * 1024 * 1024;
  const sess1 = createSession('gemini', dir);
  const writer1 = createHistoryWriter(sess1.sessionHandle, dir, 'gemini', 'turn-1');
  writer1.accept({ type: 'turn_started' });
  await writer1.flush(); // Initial flush initializes capacity tracking

  // Simulate a concurrent writer updating .capacity.meta to near the limit (TOTAL_LIMIT - 500 bytes)
  fs.writeFileSync(path.join(historyDir, '.capacity.meta'), JSON.stringify({ totalBytes: TOTAL_LIMIT - 500 }));

  // Next streaming flush adds 10KB, which would push total over 100MB
  writer1.accept({ type: 'assistant_message', messageId: 'm1', text: 'x'.repeat(10000) });
  await assert.rejects(
    async () => { await writer1.flush(); },
    /History total limit reached\./
  );

  // Deleting history updates capacity metadata
  await deleteHistory(sess1.sessionHandle, dir);
  const metaAfterDel = JSON.parse(fs.readFileSync(path.join(historyDir, '.capacity.meta'), 'utf8'));
  assert.ok(metaAfterDel.totalBytes < TOTAL_LIMIT - 500);
});

test('CUR-012: a snapshot near the total limit reserves its bytes before it is written', async t => {
  const TOTAL_LIMIT = 100 * 1024 * 1024;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-history-snapshot-capacity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.coagent8_DIR = dir;
  const sess = createSession('gemini', dir);
  const writer = createHistoryWriter(sess.sessionHandle, dir, 'gemini', 'turn-1');
  writer.accept({ type: 'turn_started' });
  for (let i = 0; i < 20; i++) {
    writer.accept({ type: 'assistant_delta', messageId: 'msg-1', text: 'x'.repeat(1024) });
    await writer.flush();
  }
  const historyDir = getHistoryDir();
  const snapshot = path.join(historyDir, `${sess.sessionHandle}.json`);
  const meta = path.join(historyDir, '.capacity.meta');
  assert.equal(fs.existsSync(snapshot), false, 'streaming deltas are not materialized');
  // Room for the small turn_finished append, not for the ~20 KiB snapshot.
  fs.writeFileSync(meta, JSON.stringify({ totalBytes: TOTAL_LIMIT - 2048 }));
  writer.accept({ type: 'turn_finished', status: 'completed' });
  await assert.rejects(writer.flush(), /History total limit reached/);
  assert.equal(fs.existsSync(snapshot), false, 'the refused snapshot was never written');
  const total = JSON.parse(fs.readFileSync(meta, 'utf8')).totalBytes;
  assert.ok(total <= TOTAL_LIMIT, `accounted total ${total} stays within the limit`);
});
