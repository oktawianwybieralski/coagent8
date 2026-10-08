'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Security modules
const {
  redactCredentialFormats,
  redactDiagnostic,
  redactSecrets,
  computeSafeCommitPoint,
  isPotentialSecretPrefix,
} = require('../src/security/index.ts');

// Activity contract
const {
  isProcessAlive,
  getSessionsDir,
  getSessionFilePath,
  isSessionActive,
} = require('../src/sessions/activity.ts');

// History submodules
const {
  SESSION_LIMIT,
  TOTAL_LIMIT,
  getHistoryDir,
  fileFor,
  logFileFor,
} = require('../src/sessions/history/types.ts');
const { paginateHistory } = require('../src/sessions/history/page.ts');
const {
  pruneHistoryDirectory,
  evictOldestSessions,
  sessionMayBeActive,
  setSessionActivityChecker,
} = require('../src/sessions/history/retention.ts');
const {
  getHistory,
  sessionHistory,
  deleteHistory,
  getTurnMapping,
  clearHistoryCache,
  invalidateHistoryCache,
} = require('../src/sessions/history/reader.ts');
const { createHistoryWriter } = require('../src/sessions/history/writer.ts');

// Main barrels
const historyMain = require('../src/sessions/history/index.ts');
const { createSession, closeSession } = require('../src/sessions/session.ts');

test('S4 security: safe credential fragment commit boundaries and redaction', () => {
  assert.equal(typeof redactCredentialFormats, 'function');
  assert.equal(typeof redactDiagnostic, 'function');
  assert.equal(typeof redactSecrets, 'function');
  assert.equal(typeof computeSafeCommitPoint, 'function');
  assert.equal(typeof isPotentialSecretPrefix, 'function');

  // Prefix detection
  assert.equal(isPotentialSecretPrefix('ghp_'), true);
  assert.equal(isPotentialSecretPrefix('Bearer'), true);
  assert.equal(isPotentialSecretPrefix('sk-'), true);
  assert.equal(isPotentialSecretPrefix('hello'), false);

  // Safe commit boundary holds back incomplete credentials mid-stream
  const openPem = 'Prefix -----BEGIN PRIVATE KEY-----\nMIIE';
  assert.equal(computeSafeCommitPoint(openPem, false), 'Prefix '.length);
  assert.equal(computeSafeCommitPoint(openPem, true), openPem.length);

  const incompleteToken = 'The token is ghp_1234';
  assert.equal(computeSafeCommitPoint(incompleteToken, false), 'The token is '.length);
  assert.equal(computeSafeCommitPoint(incompleteToken, true), incompleteToken.length);

  const ordinaryText = 'Here is regular response text without secret';
  assert.equal(computeSafeCommitPoint(ordinaryText, false), ordinaryText.length);
});

test('S4 activity: narrow process and session activity queries', () => {
  assert.equal(typeof isProcessAlive, 'function');
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(999999999), false);

  assert.equal(typeof getSessionsDir(), 'string');
  assert.equal(getSessionFilePath('bad handle with spaces'), null);

  const validHandle = 'syn_sess_0123456789abcdef01234567';
  const filePath = getSessionFilePath(validHandle);
  assert.ok(filePath && filePath.endsWith(`${validHandle}.json`));
});

test('S4 history: module decomposition and compatibility shims', () => {
  // Types & limits
  assert.equal(SESSION_LIMIT, 10 * 1024 * 1024);
  assert.equal(TOTAL_LIMIT, 100 * 1024 * 1024);
  assert.equal(typeof getHistoryDir(), 'string');

  // Functions are re-exported correctly by index and shims
  assert.equal(historyMain.createHistoryWriter, createHistoryWriter);
  assert.equal(historyMain.getHistory, getHistory);
  assert.equal(historyMain.sessionHistory, sessionHistory);
  assert.equal(historyMain.deleteHistory, deleteHistory);
  assert.equal(historyMain.pruneHistoryDirectory, pruneHistoryDirectory);
  assert.equal(historyMain.paginateHistory, paginateHistory);

});

test('S4 history: session activity checker protects active turns during eviction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-s4-activity-'));
  try {
    process.env.coagent8_DIR = dir;
    const sess = createSession('codex', dir);

    // Default activity checker sees sess is idle initially (no activePid)
    assert.equal(sessionMayBeActive(sess.sessionHandle), false);

    // Custom activity checker contract can protect specific sessions
    let protectedHandle = sess.sessionHandle;
    setSessionActivityChecker((h) => h === protectedHandle);
    assert.equal(sessionMayBeActive(sess.sessionHandle), true);
    assert.equal(sessionMayBeActive('other_handle'), false);

    // Reset activity checker
    setSessionActivityChecker(isSessionActive);
    assert.equal(sessionMayBeActive(sess.sessionHandle), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S4 boundaries: history modules have zero dependency on session.ts (runtime cycle eliminated)', () => {
  const root = path.resolve(__dirname, '..');
  const historyDir = path.join(root, 'src', 'sessions', 'history');
  const files = fs.readdirSync(historyDir, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.ts'))
    .map(f => path.join(historyDir, f));

  assert.ok(files.length >= 5, `Expected at least 5 history files, found ${files.length}`);

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
    for (const match of importMatches) {
      const specifier = match[1];
      assert.ok(
        !specifier.endsWith('session.js') && !specifier.endsWith('session.ts') && !specifier.includes('/session.'),
        `Forbidden session.ts dependency in ${path.relative(root, file)}: ${specifier}`
      );
    }
  }
});

test('S4 boundaries: history page has zero dependency on history.ts (type cycle eliminated)', () => {
  const root = path.resolve(__dirname, '..');
  const pageFile = path.join(root, 'src', 'sessions', 'history', 'page.ts');
  const code = fs.readFileSync(pageFile, 'utf8');
  const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
  for (const match of importMatches) {
    const specifier = match[1];
    assert.ok(
      !specifier.includes('reader') && !specifier.includes('history.js') && !specifier.includes('writer'),
      `Forbidden dependency in history/page.ts: ${specifier}`
    );
  }
});

test('S4 boundaries: security/ has zero dependency on sessions, backends, mcp or controller', () => {
  const root = path.resolve(__dirname, '..');
  const secDir = path.join(root, 'src', 'security');
  const files = fs.readdirSync(secDir, { recursive: true })
    .filter(f => typeof f === 'string' && f.endsWith('.ts'))
    .map(f => path.join(secDir, f));

  assert.ok(files.length >= 3, `Expected at least 3 security files, found ${files.length}`);

  for (const file of files) {
    const code = fs.readFileSync(file, 'utf8');
    const importMatches = [...code.matchAll(/(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)];
    for (const match of importMatches) {
      const specifier = match[1];
      assert.ok(
        !specifier.includes('sessions') &&
        !specifier.includes('backends') &&
        !specifier.includes('mcp') &&
        !specifier.includes('controller'),
        `Forbidden dependency in ${path.relative(root, file)}: ${specifier}`
      );
    }
  }
});

