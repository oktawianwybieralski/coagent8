'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-session-test-'));
const tempSessionsFile = path.join(tempDir, 'sessions.json');
process.env.coagent8_SESSIONS = tempSessionsFile;

const {
  createSession,
  getSession,
  updateSession,
  closeSession,
  resolveOrInitSession,
  acquireAndResolveSession,
  acquireSessionTurn,
  releaseSessionTurn,
  pruneExpiredSessions,
  getSessionsDir,
} = require('../src/sessions/session.ts');
const { createCodexStreamCollector } = require('../src/backends/codex.adapter.ts');
const { generateBugReport, sanitizeText, GITHUB_NEW_ISSUE_BASE } = require('../src/diagnostics/issue.ts');
const { handleIssue, issueToolDefinition } = require('../src/tools/issue.tool.ts');
const { handleRun } = require('../src/tools/run.tool.ts');
const { formatExecutionResult } = require('../src/tools/common.ts');

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {}
});

test('live Codex collector emits public progress without private tool operands or reasoning', () => {
  const progress = [];
  const collector = createCodexStreamCollector({ onProgress: message => progress.push(message) });
  const accept = event => collector.line(JSON.stringify(event));
  accept({ type: 'thread.started', thread_id: 'thread_progress' });
  accept({ type: 'turn.started' });
  accept({ type: 'item.started', item: { id: 'command', type: 'command_execution', command: 'private-command' } });
  accept({ type: 'item.started', item: { id: 'search', type: 'web_search', query: 'private-query' } });
  accept({ type: 'item.started', item: { id: 'tool', type: 'mcp_tool_call', arguments: { path: 'private-path' } } });
  accept({ type: 'item.started', item: { type: 'thought', summary: 'private-reasoning' } });
  accept({ type: 'item.started', item: { id: 'message', type: 'agent_message', text: 'Public findings' } });
  assert.deepEqual(progress, [
    'Initializing Codex session...', 'Starting task analysis...', 'Executing sandbox command...',
    'Executing web search...', 'Executing MCP tool...', 'Analyzing context and architecture...', 'Formulating findings...',
  ]);
  assert.equal(collector.snapshot().output, 'Public findings');
  assert.doesNotMatch(JSON.stringify(progress) + collector.snapshot().output, /private-/);
});

test('session manager persists, updates, and closes multi-turn session handles cleanly', async () => {
  // Create session
  const session = createSession('codex', process.cwd());
  assert.ok(session);
  assert.ok(session.sessionHandle.startsWith('syn_sess_'));
  assert.equal(session.backend, 'codex');
  assert.equal(session.threadId, null);

  // Retrieve session
  const loaded = getSession(session.sessionHandle);
  assert.ok(loaded);
  assert.equal(loaded.sessionHandle, session.sessionHandle);

  // Update session with captured CLI threadId
  const updated = await updateSession(session.sessionHandle, { threadId: 'thread_xyz999' });
  assert.equal(updated.threadId, 'thread_xyz999');

  const reloaded = getSession(session.sessionHandle);
  assert.equal(reloaded.threadId, 'thread_xyz999');

  // Close session
  const closed = await closeSession(session.sessionHandle);
  assert.equal(closed, true);
  assert.equal(getSession(session.sessionHandle), null);

  // Workspace and backend validation
  const sess2 = createSession('codex', path.join(tempDir, 'project-a'));
  assert.ok(getSession(sess2.sessionHandle, { backend: 'codex', workspace: path.join(tempDir, 'project-a') }));
  assert.equal(getSession(sess2.sessionHandle, { backend: 'claude' }), null);
  assert.equal(getSession(sess2.sessionHandle, { workspace: path.join(tempDir, 'project-b') }), null);

  // resolveOrInitSession tests
  const resolvedValid = resolveOrInitSession(sess2.sessionHandle, 'codex', path.join(tempDir, 'project-a'));
  assert.ok(resolvedValid.session);
  assert.equal(resolvedValid.session.sessionHandle, sess2.sessionHandle);

  const resolvedInvalid = resolveOrInitSession('syn_sess_nonexistent', 'codex', path.join(tempDir, 'project-a'));
  assert.ok(resolvedInvalid.error);
  assert.ok(resolvedInvalid.error.includes('Invalid or expired session handle'));

  const resolvedWrongDir = resolveOrInitSession(sess2.sessionHandle, 'codex', path.join(tempDir, 'project-b'));
  assert.ok(resolvedWrongDir.error);

  const resolvedFresh = resolveOrInitSession(null, 'codex', path.join(tempDir, 'project-a'));
  assert.ok(resolvedFresh.session);
  assert.ok(resolvedFresh.session.sessionHandle.startsWith('syn_sess_'));

  // Concurrency & process isolation test
  const sessA = createSession('codex', path.join(tempDir, 'workspace-1'));
  const sessB = createSession('codex', path.join(tempDir, 'workspace-2'));
  await updateSession(sessA.sessionHandle, { threadId: 'thread_aaa' });
  await updateSession(sessB.sessionHandle, { threadId: 'thread_bbb' });
  assert.equal(getSession(sessA.sessionHandle).threadId, 'thread_aaa');
  assert.equal(getSession(sessB.sessionHandle).threadId, 'thread_bbb');
  await closeSession(sessA.sessionHandle);
  assert.equal(getSession(sessA.sessionHandle), null);
  assert.equal(getSession(sessB.sessionHandle).threadId, 'thread_bbb');

  // Turn serialization test
  const turn1 = await acquireSessionTurn(sessB.sessionHandle);
  assert.equal(turn1.ok, true);

  // Competing turn on same session while busy
  const turn2 = await acquireSessionTurn(sessB.sessionHandle);
  assert.equal(turn2.ok, false);
  assert.ok(turn2.error.includes('currently busy executing another turn'));

  // Attempting to close while busy throws
  await assert.rejects(async () => {
    await closeSession(sessB.sessionHandle);
  }, /Cannot close session.*busy executing another turn/);

  // Release turn
  await releaseSessionTurn(sessB.sessionHandle);

  // acquireAndResolveSession acquires turn and returns session
  const turnResolved = await acquireAndResolveSession(sessB.sessionHandle, 'codex', path.join(tempDir, 'workspace-2'));
  assert.ok(turnResolved.session);
  assert.equal(turnResolved.session.sessionHandle, sessB.sessionHandle);

  // A concurrent turn while resolved turn is open is rejected
  const turnConcurrent = await acquireAndResolveSession(sessB.sessionHandle, 'codex', path.join(tempDir, 'workspace-2'));
  assert.ok(turnConcurrent.error);
  assert.ok(turnConcurrent.error.includes('currently busy executing another turn'));

  await releaseSessionTurn(sessB.sessionHandle);

  // After turn release, closing succeeds
  const closedB = await closeSession(sessB.sessionHandle);
  assert.equal(closedB, true);
});

test('pruneExpiredSessions removes expired sessions and preserves legacy artifacts', async () => {
  const sessionsDir = getSessionsDir();
  const activeSess = createSession('codex', path.join(tempDir, 'active'));

  // Create an expired session file (> 2h old)
  const expiredHandle = 'syn_sess_expired123';
  const expiredFile = path.join(sessionsDir, `${expiredHandle}.json`);
  const twoHoursAndTenMinsAgo = new Date(Date.now() - 130 * 60 * 1000).toISOString();
  fs.writeFileSync(expiredFile, JSON.stringify({
    sessionHandle: expiredHandle,
    backend: 'codex',
    workspace: path.join(tempDir, 'active'),
    createdAt: twoHoursAndTenMinsAgo,
    lastUsedAt: twoHoursAndTenMinsAgo,
  }), 'utf8');

  // Create an expired busy lock
  const expiredBusy = path.join(sessionsDir, `${expiredHandle}.busy`);
  fs.writeFileSync(expiredBusy, JSON.stringify({ pid: 9999999, lockedAt: Date.now() - 130 * 60 * 1000 }), 'utf8');

  assert.ok(fs.existsSync(expiredFile));
  assert.ok(fs.existsSync(expiredBusy));

  // Run forced prune
  await pruneExpiredSessions(true);

  // Expired files should be purged
  assert.equal(fs.existsSync(expiredFile), false);
  assert.equal(fs.existsSync(expiredBusy), true, 'Legacy lock paths are not deleted by the new owner protocol');

  // Active session should remain intact
  assert.ok(getSession(activeSess.sessionHandle));
});

test('acquireSessionTurn safely reclaims lock held by dead process', async () => {
  const sess = createSession('codex', path.join(tempDir, 'dead-proc-test'));
  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${sess.sessionHandle}.json`);

  // Simulate a turn belonging to a dead PID (e.g. 99999999)
  const sessionData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  sessionData.activePid = 99999999;
  sessionData.activeTurnAt = Date.now() - 20000;
  fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');

  // acquireSessionTurn should detect dead PID, safely reclaim the turn, and succeed
  const turn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(turn.ok, true);

  // We now own the turn
  const updated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(updated.activePid, process.pid);

  await releaseSessionTurn(sess.sessionHandle);
  const released = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(released.activePid, null);
});

test('issue reporting generates sanitized GitHub pre-filled issue URL and redacts secrets', async () => {
  const secretText = `Error at ${os.homedir()}/projects/secret: connection failed with API key sk-proj12345678901234567890, AWS key AKIAIOSFODNN7EXAMPLE, Slack xoxb-1234567890-abcdefgh, and api_key="secretPassword123" and https://api.com?token=superSecretToken. Also Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.`;
  const sanitized = sanitizeText(secretText);

  assert.ok(!sanitized.includes('sk-proj12345678901234567890'));
  assert.ok(sanitized.includes('sk-***[REDACTED]***'));
  assert.ok(sanitized.includes('Bearer ***[REDACTED]***'));
  assert.ok(sanitized.includes('AKIA***[REDACTED]***'));
  assert.ok(sanitized.includes('xox-***[REDACTED]***'));
  assert.ok(sanitized.includes('api_key="***[REDACTED]***"'));
  assert.ok(sanitized.includes('token=***[REDACTED]***'));
  assert.ok(!sanitized.includes(os.homedir()));
  assert.ok(sanitized.includes('~'));

  // Test edge cases: JSON quoted keys, passwords with punctuation, short Bearer tokens, URL credentials
  const edgeSecretText = `Config: {"api_key":"abcd1234SECRET"}, env: password=abc!def123, header: Authorization: Bearer abc, json: {"password":"abc;def"}, git: https://alice:superSecret@host.com/repo.git, token_url: https://secretToken123@api.com, user_url: https://user:@host.com`;
  const sanitizedEdge = sanitizeText(edgeSecretText);
  assert.equal(
    sanitizedEdge,
    `Config: {"api_key":"***[REDACTED]***"}, env: password=***[REDACTED]***, header: Authorization: Bearer ***[REDACTED]***, json: {"password":"***[REDACTED]***"}, git: https://***[REDACTED]***@host.com/repo.git, token_url: https://***[REDACTED]***@api.com, user_url: https://***[REDACTED]***@host.com`
  );

  // Test safe surrogate handling with emojis
  const emojiError = 'Crash with rocket 🚀'.repeat(200);
  const emojiReport = generateBugReport({
    errorMessage: emojiError,
    context: 'Testing emoji surrogates',
  });
  assert.doesNotThrow(() => {
    decodeURIComponent(emojiReport.issueUrl);
  });

  const report = generateBugReport({
    errorMessage: 'Process failed with exit code 1',
    context: 'Running omniagent_review on uncommitted changes',
    doctorReport: {
      backends: {
        codex: { name: 'OpenAI Codex CLI', installed: true, version: '0.160.0' },
        claude: { name: 'Claude Code CLI', installed: false },
      },
    },
  });

  assert.ok(report.issueUrl.startsWith(GITHUB_NEW_ISSUE_BASE));
  assert.ok(report.issueUrl.includes('title='));
  assert.ok(report.issueUrl.includes('body='));
  assert.ok(report.prompt.includes('Would you like to report this issue to GitHub'));
  assert.ok(report.prompt.includes(GITHUB_NEW_ISSUE_BASE));
});

test('diagnostic and issue truncation cannot expose recognized credential prefixes', () => {
  const {redactDiagnostic}=require('../src/redaction.ts');
  const {truncateToByteLength}=require('../src/execution/stream.ts');
  const key='sk-'+'A'.repeat(40);
  for(const input of ['{"api_key":"fixtureSecret','password=\'fixtureSecret','{"token":"fixtureSecret\\','{"secret":"fixtureSecret\\\n']) {
    const {redactSecrets}=require('../src/redaction.ts');
    assert.ok(!redactSecrets(input).includes('fixtureSecret'));assert.ok(!redactDiagnostic(input).includes('fixtureSecret'));assert.ok(!sanitizeText(input).includes('fixtureSecret'));
  }
  for(const budget of [64,512,4096,512*1024]){
    const input='x'.repeat(budget-16)+' '+key;
    for(const value of [redactDiagnostic(input,budget),redactDiagnostic(truncateToByteLength(input,budget),budget)]){
      assert.ok(!value.includes('sk-A'),value.slice(-80));assert.ok(Buffer.byteLength(value)<=budget);
    }
  }
  assert.ok(!sanitizeText('x'.repeat(4080)+' '+key).includes('sk-A'));
});

test('issue sanitization covers Basic auth, AWS secret keys, semicolons in unquoted passwords, and resists ReDoS', async () => {
  const {redactSecrets}=require('../src/redaction.ts');
  const keys='-----BEGIN PRIVATE KEY-----\nPRIVATE_DER_SECRET\n-----END PRIVATE KEY-----\n{"aws_access_key_id":"QUOTED_ID_SECRET","aws_secret_access_key":"QUOTED_AWS_SECRET"}';
  for(const secret of ['PRIVATE_DER_SECRET','QUOTED_ID_SECRET','QUOTED_AWS_SECRET'])assert.ok(!redactSecrets(keys).includes(secret));
  // Test Basic auth, temporary AWS keys (ASIA), and complex passwords with semicolons and equals
  const leakedText = 'Authorization: Basic dXNlcjpwYXNzd29yZA== and AWS_ACCESS_KEY_ID=ASIA1234567890ABCDEF and AWS_SECRET_ACCESS_KEY=superSecretValue and password=abc;def=ghi and aws_session_token=xyz123';
  const sanitized = sanitizeText(leakedText);
  assert.ok(!sanitized.includes('dXNlcjpwYXNzd29yZA=='));
  assert.ok(!sanitized.includes('ASIA1234567890ABCDEF'));
  assert.ok(!sanitized.includes('superSecretValue'));
  assert.ok(!sanitized.includes('abc;def=ghi'));
  assert.ok(!sanitized.includes('def=ghi'));
  assert.ok(!sanitized.includes('xyz123'));
  assert.ok(sanitized.includes('Authorization: Basic ***[REDACTED]***'));
  assert.ok(sanitized.includes('AWS_ACCESS_KEY_ID=***[REDACTED]***'));
  assert.ok(sanitized.includes('AWS_SECRET_ACCESS_KEY=***[REDACTED]***'));
  assert.ok(sanitized.includes('password=***[REDACTED]***'));
  assert.ok(sanitized.includes('aws_session_token=***[REDACTED]***'));

  // Test code confidentiality: raw code blocks, unterminated blocks, tildes, and git diffs
  const codeText = 'Error occurred during test:\n```typescript\nconst proprietarySecret = "internal_secret_value";\n```\n~~~python\nsecret_python = 42\n~~~\ndiff --git a/src/secret.js b/src/secret.js\n+ secret diff\n';
  const sanitizedCode = sanitizeText(codeText);
  assert.ok(!sanitizedCode.includes('proprietarySecret'));
  assert.ok(!sanitizedCode.includes('secret_python'));
  assert.ok(!sanitizedCode.includes('+ secret diff'));
  assert.ok(sanitizedCode.includes('[code block redacted for privacy]'));
  assert.ok(sanitizedCode.includes('[git diff redacted for privacy]'));

  // Unterminated code block (e.g. truncated closing fence)
  const unterminatedCode = 'Prefix info:\n```typescript\nconst unterminatedSecret = "must_not_leak";';
  const sanitizedUnterminated = sanitizeText(unterminatedCode);
  assert.ok(!sanitizedUnterminated.includes('unterminatedSecret'));
  assert.ok(sanitizedUnterminated.includes('[code block redacted for privacy]'));

  // Embedded fence delimiter test: tilde block containing ``` must not terminate early
  const embeddedFenceCode = '~~~markdown\ncode here:\n```javascript\nconst leakedInner = "secret123";\n```\nconst leakedAfter = "secret456";\n~~~';
  const sanitizedEmbedded = sanitizeText(embeddedFenceCode);
  assert.ok(!sanitizedEmbedded.includes('leakedInner'));
  assert.ok(!sanitizedEmbedded.includes('leakedAfter'));

  // ReDoS test: 40,000 'a' characters must sanitize linearly in under 100ms
  const longA = 'a'.repeat(40000);
  const start = Date.now();
  const sanitizedA = sanitizeText(longA);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Sanitization took too long (${elapsed}ms), possible ReDoS`);
  assert.ok(sanitizedA.length <= 4096, 'Bounded length should be enforced');
});

test('active session turn is strictly immune from TTL expiration while executing', async () => {
  const sess = createSession('codex', path.join(tempDir, 'active-ttl-test'));
  assert.equal((await acquireSessionTurn(sess.sessionHandle)).ok, true);
  const sessionsDir = getSessionsDir();
  const filePath = path.join(sessionsDir, `${sess.sessionHandle}.json`);

  // Simulate an active turn owned by this live process, but lastUsedAt is 3 hours ago (> 2h TTL)
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const rawSession = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  rawSession.activePid = process.pid;
  rawSession.activeTurnAt = Date.now() - 3 * 3600 * 1000;
  rawSession.lastUsedAt = threeHoursAgo;
  fs.writeFileSync(filePath, JSON.stringify(rawSession, null, 2), 'utf8');

  // getSession MUST NOT delete an actively executing session
  const loaded = getSession(sess.sessionHandle);
  assert.ok(loaded, 'Actively executing session should not be expired or deleted by getSession');
  assert.equal(loaded.activePid, process.pid);
  assert.ok(fs.existsSync(filePath), 'Session file must remain on disk while executing');

  // While busy, concurrent turn is rejected
  const busyTurn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(busyTurn.ok, false);

  // Release the turn
  await releaseSessionTurn(sess.sessionHandle);

  // Now acquire a new turn cleanly
  const turn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(turn.ok, true);
  assert.ok(fs.existsSync(filePath));

  // Release turn again
  await releaseSessionTurn(sess.sessionHandle);

  // Now that turn is released (IDLE), backdate lastUsedAt to 3 hours ago
  const idleSession = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  idleSession.lastUsedAt = threeHoursAgo;
  fs.writeFileSync(filePath, JSON.stringify(idleSession, null, 2), 'utf8');

  // Now that it is idle, getSession strictly expires and cleans it up
  const expired = getSession(sess.sessionHandle);
  assert.equal(expired, null, 'Idle session older than 2 hours should expire');
  await pruneExpiredSessions(true);
  assert.equal(fs.existsSync(filePath), false, 'Expired idle session file should be unlinked');
});

test('createCodexStreamCollector accumulates message updates from created -> updated -> completed without losing findings', async () => {
  const collector = createCodexStreamCollector();

  // 1. Thread started event
  collector.pushChunk(JSON.stringify({ type: 'thread.started', thread_id: 'thread_audit_123' }) + '\n');
  assert.equal(collector.getCapturedThreadId(), 'thread_audit_123');

  // 2. Stream partial message
  collector.pushChunk(JSON.stringify({
    type: 'item.created',
    item: { id: 'msg_0', type: 'agent_message', text: 'Partial analysis: checking lock mechanism...' }
  }) + '\n');
  assert.equal(collector.getFormattedOutput(), 'Partial analysis: checking lock mechanism...');

  // 3. Stream updated message
  collector.pushChunk(JSON.stringify({
    type: 'item.updated',
    item: { id: 'msg_0', type: 'agent_message', text: 'Partial analysis: identified race window in reclamation.' }
  }) + '\n');
  assert.equal(collector.getFormattedOutput(), 'Partial analysis: identified race window in reclamation.');

  // 4. Stream completed message with final audit findings
  collector.pushChunk(JSON.stringify({
    type: 'item.completed',
    item: { id: 'msg_0', type: 'agent_message', text: 'Audit Findings:\n- Mutual exclusion verified with reclaimMutex.\n- Zero P1/P2 issues.' }
  }) + '\n');
  collector.flush();

  const finalOutput = collector.getFormattedOutput();
  assert.ok(finalOutput.includes('Mutual exclusion verified with reclaimMutex'));
  assert.ok(finalOutput.includes('Zero P1/P2 issues'));
  assert.ok(!finalOutput.includes('checking lock mechanism'));
});

test('createCodexStreamCollector safely discards oversized records without corrupting JSONL boundaries', async () => {
  const collector = createCodexStreamCollector({ maxLineBuffer: 1024 }); // 1KB test limit

  // Send a valid message chunk
  collector.pushChunk(JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: 'First valid report' }
  }) + '\n');

  // Send an oversized record (> 1KB) without newline
  const bigChunk = '{"type":"raw_log","content":"' + 'X'.repeat(2000) + '"}';
  collector.pushChunk(bigChunk); // exceeds maxLineBuffer, gets discarded cleanly

  // Send the newline terminating the oversized record, followed immediately by another valid message
  collector.pushChunk('\n' + JSON.stringify({
    type: 'item.completed',
    item: { id: 'm2', type: 'agent_message', text: 'Second valid report after oversized skip' }
  }) + '\n');

  collector.flush();

  const output = collector.getFormattedOutput();
  assert.ok(output.includes('First valid report'));
  assert.ok(output.includes('Second valid report after oversized skip'));
  assert.ok(!output.includes('XXXXX'));
  assert.equal(collector.getRawFallbackLines().length, 0, 'No corrupted JSON fragments in fallback');
});

test('dead legacy lock is preserved while the new unique-claim protocol acquires the turn', async () => {
  const sess = createSession('codex', path.join(tempDir, 'competing-reclaim'));
  const sessionsDir = getSessionsDir();
  const lockFile = path.join(sessionsDir, `${sess.sessionHandle}.json.lock`);
  const reclaimMutex = `${lockFile}.reclaim`;

  // Write a stale lock file with dead PID
  const staleData = JSON.stringify({ token: 'dead_token', pid: 99999999, time: Date.now() - 10000 });
  fs.writeFileSync(lockFile, staleData, 'utf8');

  // Legacy shared pathnames are never reclaimed or replaced by the new protocol.
  const turn = await acquireSessionTurn(sess.sessionHandle);
  assert.equal(turn.ok, true);
  assert.equal(fs.readFileSync(lockFile,'utf8'),staleData);

  assert.equal(fs.existsSync(reclaimMutex), false);

  await releaseSessionTurn(sess.sessionHandle);
});

test('createCodexStreamCollector retains bounded latest text under budget pressure rather than stale draft', async () => {
  // Set a tight budget of 150 bytes total
  const collector = createCodexStreamCollector({ maxTotalMessageBytes: 150 });

  // Stream initial partial draft (60 bytes)
  collector.pushChunk(JSON.stringify({
    type: 'item.created',
    item: { id: 'm1', type: 'agent_message', text: 'Initial partial analysis draft from turn.' }
  }) + '\n');
  assert.equal(collector.getFormattedOutput(), 'Initial partial analysis draft from turn.');

  // Stream final large findings (250 bytes), which exceeds the 150 bytes budget
  const finalFindings = 'Final comprehensive findings: identified 0 vulnerabilities in review, confirmed mutual exclusion and strict secret masking. '.repeat(2);
  collector.pushChunk(JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: finalFindings }
  }) + '\n');
  collector.flush();

  const output = collector.getFormattedOutput();
  // It must NOT keep the stale "Initial partial analysis draft"
  assert.ok(!output.includes('Initial partial analysis draft'));
  // It MUST keep the latest final findings with explicit truncation marker
  assert.ok(output.includes('Final comprehensive findings'));
  assert.ok(output.includes('[truncated]'));

  // Reduced budget test (40 bytes total): 5-byte draft + 35-byte message leaves 0 bytes available
  const tightCollector = createCodexStreamCollector({ maxTotalMessageBytes: 40 });
  tightCollector.pushChunk(JSON.stringify({
    type: 'item.created',
    item: { id: 'm1', type: 'agent_message', text: 'draft' }
  }) + '\n');
  tightCollector.pushChunk(JSON.stringify({
    type: 'item.created',
    item: { id: 'm2', type: 'agent_message', text: '01234567890123456789012345678901234' } // 35 bytes
  }) + '\n');
  // Final text arrives for m1
  tightCollector.pushChunk(JSON.stringify({
    type: 'item.completed',
    item: { id: 'm1', type: 'agent_message', text: 'final text for m1' }
  }) + '\n');
  tightCollector.flush();
  const tightOutput = tightCollector.getFormattedOutput();
  assert.ok(!tightOutput.includes('draft'), 'Stale draft must never survive under tight budget');
  assert.ok(tightOutput.includes('[truncated]'), 'Must indicate truncation');
});

test('canonical issue tool formats bug report, executes doctor by default, and supports opting out', async () => {
  assert.equal(issueToolDefinition.name, 'issue');
  assert.ok(issueToolDefinition.description.includes('privacy-sanitized bug report'));

  // Default with doctor
  const resWithDoc = await handleIssue({
    error_message: 'Spawn failed with ENOENT',
    context: 'Calling debug tool on Windows',
  });
  assert.ok(resWithDoc.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(resWithDoc.content[0].text.includes(GITHUB_NEW_ISSUE_BASE));
  assert.ok(resWithDoc.structuredContent.issueUrl.includes('title='));
  assert.ok(resWithDoc.structuredContent.body.includes('Spawn failed with ENOENT'));

  // Opting out of doctor
  const resNoDoc = await handleIssue({
    error_message: 'Configuration syntax error',
    context: 'Parsing custom config.json',
    include_doctor: false,
  });
  assert.ok(resNoDoc.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(resNoDoc.structuredContent.body.includes('Not provided'));

  // Output schema assertion
  assert.ok(issueToolDefinition.outputSchema);
  assert.deepEqual(issueToolDefinition.outputSchema.required, ['title', 'body', 'issueUrl']);
});

test('server advertises issue tool and dispatches tools/call issue cleanly', async () => {
  const { createServer, createToolDefinitions } = require('../src/server.ts');
  const server = createServer();
  const tools = createToolDefinitions();
  const advertisedIssue = tools.find(t => t.name === 'issue');
  assert.ok(advertisedIssue, 'Canonical profile must advertise issue tool');
  assert.ok(advertisedIssue.outputSchema, 'Advertised issue must include outputSchema');

  const advertisedRun = tools.find(t => t.name === 'run');
  // Check run when in callable definitions
  const { getAllCallableToolDefinitions } = require('../src/server.ts');
  const allCallable = getAllCallableToolDefinitions();
  const runDef = allCallable.find(t => t.name === 'run');
  assert.ok(runDef.outputSchema.anyOf, 'Run gateway outputSchema must be a union (anyOf) accommodating both execution and issue');
  assert.equal(runDef.outputSchema.type, 'object', 'Run gateway outputSchema must declare root type: object');

  // Verify compact profile tools pass SDK's ListToolsResultSchema validation
  const { ListToolsResultSchema } = require('@modelcontextprotocol/sdk/types.js');
  const compactTools = createToolDefinitions({
    schemaVersion: 1,
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude', 'gemini'] },
    toolProfile: 'compact',
  });
  const parsedCompact = ListToolsResultSchema.parse({ tools: compactTools });
  assert.equal(parsedCompact.tools.length, 4);

  // tools/call dispatch
  const callHandler = server._requestHandlers.get('tools/call');
  const callRes = await callHandler(
    { method: 'tools/call', params: { name: 'issue', arguments: { error_message: 'Test crash', include_doctor: false } } },
    { signal: null }
  );
  assert.equal(callRes.isError, undefined);
  assert.ok(callRes.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(callRes.structuredContent.body.includes('Test crash'));
});

test('run gateway dispatches action: "issue" to handleIssue cleanly', async () => {
  const result = await handleRun(
    {
      action: 'issue',
      error_message: 'Command exited with 127',
      context: 'Gateway invocation smoke test',
      include_doctor: false,
    },
    tempDir
  );
  assert.ok(result.content[0].text.includes('Submit Bug Report on GitHub'));
  assert.ok(result.structuredContent.body.includes('Command exited with 127'));
});

test('formatExecutionResult appends issue reporting link strictly on fatal unrecoverable system errors', async () => {
  // 1. Fatal PROCESS_ERROR
  const resProcessErr = await formatExecutionResult(
    'codex',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'PROCESS_ERROR', message: 'Failed to spawn powershell supervisor', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 100, historyAvailable: false }
  );
  const textProcessErr = resProcessErr.content[0].text;
  assert.ok(textProcessErr.includes('> Report this issue: [Open pre-filled GitHub Issue](https://github.com/oktawianwybieralski/coagent8/issues/new?'));
  assert.ok(textProcessErr.includes('PROCESS_ERROR'));

  // 2. Fatal CLI_UNSUPPORTED
  const resCliErr = await formatExecutionResult(
    'gemini',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'CLI_UNSUPPORTED', message: 'Version 0.50.0 is below required 0.62.0', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 50, historyAvailable: false }
  );
  assert.ok(resCliErr.content[0].text.includes('> Report this issue: [Open pre-filled GitHub Issue](https://github.com/oktawianwybieralski/coagent8/issues/new?'));

  // 3. Fatal PROTOCOL_ERROR
  const resProtoErr = await formatExecutionResult(
    'claude',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'PROTOCOL_ERROR', message: 'Received corrupt JSON streaming frame', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 80, historyAvailable: false }
  );
  assert.ok(resProtoErr.content[0].text.includes('> Report this issue: [Open pre-filled GitHub Issue](https://github.com/oktawianwybieralski/coagent8/issues/new?'));

  // 4. Non-fatal RATE_LIMITED: must NOT append issue link
  const resRateLimited = await formatExecutionResult(
    'codex',
    {
      status: 'failed',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'RATE_LIMITED', message: 'Quota exhausted for this window', retryable: true },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 30, historyAvailable: false }
  );
  assert.ok(!resRateLimited.content[0].text.includes('> Report this issue:'));

  // 5. Non-fatal ABORTED: must NOT append issue link
  const resAborted = await formatExecutionResult(
    'codex',
    {
      status: 'cancelled',
      isError: true,
      output: '',
      truncated: false,
      continuationAvailable: false,
      error: { code: 'ABORTED', message: 'User cancelled turn', retryable: false },
    },
    '',
    null,
    { turn: 1, toolCount: 0, durationMs: 10, historyAvailable: false }
  );
  assert.ok(!resAborted.content[0].text.includes('> Report this issue:'));
});

