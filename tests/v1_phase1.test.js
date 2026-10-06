const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-phase1-'));
process.env.coagent8_DIR = tempDir;
process.env.GEMINI_CLI_HOME = path.join(tempDir, 'gemini-home');
process.env.GEMINI_PATH = path.resolve(__dirname, 'fixtures/gemini-cli/gemini.cjs');

const {
  execute: executeGemini,
  resolveModelAndEffort,
  createGeminiCollector,
} = require('../src/backends/gemini.adapter.ts');

const {
  StreamReducer,
  createStreamReducer,
  truncateToByteLength,
} = require('../src/execution/stream-reducer.ts');

const {
  terminateProcessTree,
  runCommand,
  startDescendantTracking,
  trackedDescendants,
} = require('../src/execution/process.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// =========================================================================
// Task 1.1: STDIN Prompt Delivery for Antigravity (agy)
// =========================================================================

test('Phase 1 Task 1.1: prompt is delivered via STDIN and omitted from CLI args', async () => {
  const capturePath = path.join(tempDir, 'capture-stdin.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;

  const testPrompt = 'Synthesize architecture and audit diff boundaries.';
  const result = await executeGemini(testPrompt, { cwd: tempDir });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(fs.existsSync(capturePath), 'Fixture capture must exist');

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.prompt, testPrompt, 'Prompt must be received by process stdin');
  assert.ok(!capture.args.includes('-p'), 'CLI args must not include -p flag');
  assert.ok(!capture.args.includes('--print'), 'CLI args must not include --print with prompt value');
  assert.ok(!capture.args.includes(testPrompt), 'Prompt text must not be passed in CLI argument vector');

  delete process.env.coagent8_FIXTURE_CAPTURE;
});

test('Phase 1 Task 1.1: large prompts exceeding 32KB pass safely via STDIN without CreateProcessW limit crashes', async () => {
  const capturePath = path.join(tempDir, 'capture-large-stdin.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;

  // 64KB prompt - exceeds Windows 32767 chars CreateProcessW command line limit
  const largePrompt = 'A'.repeat(64 * 1024);
  const result = await executeGemini(largePrompt, { cwd: tempDir });

  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(fs.existsSync(capturePath));

  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
  assert.equal(capture.prompt.length, 64 * 1024, 'Full 64KB prompt delivered via stdin');
  assert.ok(!capture.args.includes(largePrompt), 'Large prompt was not in argv');

  delete process.env.coagent8_FIXTURE_CAPTURE;
});

// =========================================================================
// Task 1.2: Clean Windows Process Lifecycle
// =========================================================================

test('Phase 1 Task 1.2: direct process launch without PowerShell wrapper or C# Roslyn compilation', async () => {
  assert.ok(!fs.existsSync(path.resolve('assets/windows-job.ps1')), 'assets/windows-job.ps1 must be retired');
  const result = await runCommand(process.execPath, ['-e', 'console.log("direct_launch_ok")']);
  assert.equal(result.status, 'completed');
  assert.ok(result.stdout.includes('direct_launch_ok'));
});

test('Phase 1 Task 1.2: terminateProcessTree terminates running process cleanly without leaving orphans', async () => {
  // Launch an idle child process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });

  const pid = child.pid;
  assert.ok(pid, 'Child process must have a PID');

  // Verify process is running
  assert.doesNotThrow(() => process.kill(pid, 0), 'Child process should be running');

  // Terminate process tree
  await terminateProcessTree(child);

  // Allow OS a small grace window to release PID
  await new Promise(r => setTimeout(r, 200));

  // Verify process is dead
  assert.throws(() => process.kill(pid, 0), 'Process must be dead after terminateProcessTree');
});

// =========================================================================
// Task 1.3: Decouple Base Models from Reasoning Effort
// =========================================================================

test('Phase 1 Task 1.3: resolveModelAndEffort decouples base models from reasoning effort', () => {
  // 1. Explicit effort strips synthetic suffix
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', 'low'), {
    model: 'gemini-3.8-flash',
    effort: 'low',
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', 'high'), {
    model: 'gemini-3.8-flash',
    effort: 'high',
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.7-flash-medium', 'max'), {
    model: 'gemini-3.7-flash',
    effort: 'max',
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.1-pro-low', 'high'), {
    model: 'gemini-3.1-pro',
    effort: 'high',
  });
  assert.deepEqual(resolveModelAndEffort('gpt-oss-120b-medium', 'xhigh'), {
    model: 'gpt-oss-120b',
    effort: 'xhigh',
  });

  // 2. Explicit effort on model without synthetic suffix preserves model
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash', 'medium'), {
    model: 'gemini-3.8-flash',
    effort: 'medium',
  });
  assert.deepEqual(resolveModelAndEffort('claude-sonnet-4-6', 'high'), {
    model: 'claude-sonnet-4-6',
    effort: 'high',
  });

  // 3. Model without effort specified retains its exact name (for catalog matching)
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', undefined), {
    model: 'gemini-3.8-flash-high',
    effort: undefined,
  });
  assert.deepEqual(resolveModelAndEffort('gemini-3.8-flash-high', null), {
    model: 'gemini-3.8-flash-high',
    effort: undefined,
  });

  // 4. Undefined model with explicit effort
  assert.deepEqual(resolveModelAndEffort(undefined, 'high'), {
    model: undefined,
    effort: 'high',
  });
});

test('Phase 1 Task 1.3: execute separates model and effort into distinct CLI arguments', async () => {
  const capturePath = path.join(tempDir, 'capture-model-effort.json');
  process.env.coagent8_FIXTURE_CAPTURE = capturePath;

  await executeGemini('test prompt', {
    cwd: tempDir,
    model: 'gemini-3.8-flash-high',
    reasoningEffort: 'low',
  });

  assert.ok(fs.existsSync(capturePath));
  const capture = JSON.parse(fs.readFileSync(capturePath, 'utf8'));

  // Suffix -high was stripped because effort low was explicitly specified
  const modelIdx = capture.args.indexOf('--model');
  assert.ok(modelIdx !== -1, 'Must include --model flag');
  assert.equal(capture.args[modelIdx + 1], 'gemini-3.8-flash', 'Model must have suffix stripped');

  const effortIdx = capture.args.indexOf('--effort');
  assert.ok(effortIdx !== -1, 'Must include --effort flag');
  assert.equal(capture.args[effortIdx + 1], 'low', 'Effort must be low');

  delete process.env.coagent8_FIXTURE_CAPTURE;
});

// =========================================================================
// Task 1.4: Unified Stream Reducer
// =========================================================================

test('Phase 1 Task 1.4: truncateToByteLength truncates safely along UTF-8 multi-byte boundaries', () => {
  const polish = 'zażółć gęślą jaźń';
  const emoji = '😀🎉🚀🔥💎';

  // Never corrupts Polish characters
  for (let limit = 0; limit <= Buffer.byteLength(polish, 'utf8') + 5; limit++) {
    const truncated = truncateToByteLength(polish, limit);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= limit);
    assert.ok(!truncated.includes('\uFFFD'), `Limit ${limit} produced replacement character`);
  }

  // Never corrupts 4-byte UTF-8 emoji
  for (let limit = 0; limit <= Buffer.byteLength(emoji, 'utf8') + 5; limit++) {
    const truncated = truncateToByteLength(emoji, limit);
    assert.ok(Buffer.byteLength(truncated, 'utf8') <= limit);
    assert.ok(!truncated.includes('\uFFFD'), `Limit ${limit} produced replacement character`);
  }

  // Suffix handling
  const withSuffix = truncateToByteLength('abcdefghijklmnopqrstuvwxyz', 15, '...[trunc]');
  assert.ok(Buffer.byteLength(withSuffix, 'utf8') <= 15);
  assert.ok(withSuffix.endsWith('...[trunc]'));
});

test('Phase 1 Task 1.4: StreamReducer preserves record boundaries, handles streaming chunks, and flushes cleanly', () => {
  const reducer = createStreamReducer({ maxLineBuffer: 1024 });
  const lines = [];

  // Split chunk across boundary
  reducer.pushChunk('{"type":"start"', l => lines.push(l));
  assert.equal(lines.length, 0, 'No complete line yet');

  reducer.pushChunk('}\n{"type":"step"}\n', l => lines.push(l));
  assert.equal(lines.length, 2, 'Two complete lines received');
  assert.equal(lines[0], '{"type":"start"}');
  assert.equal(lines[1], '{"type":"step"}');

  // Incomplete fragment flushed at end
  reducer.pushChunk('{"type":"end"}', l => lines.push(l));
  assert.equal(lines.length, 2);
  reducer.flush(l => lines.push(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '{"type":"end"}');
});

test('Phase 1 Task 1.4: StreamReducer safely discards oversized records without breaking JSONL boundaries', () => {
  const reducer = new StreamReducer({ maxLineBuffer: 256 });
  const lines = [];

  // Valid small record
  reducer.pushChunk('{"id":1}\n', l => lines.push(l));
  assert.equal(lines.length, 1);

  // Oversized record exceeding 256 bytes without newline
  reducer.pushChunk('{"huge":"' + 'X'.repeat(500) + '"}');
  assert.equal(reducer.hasOversizedLine(), true);

  // Newline terminates the discarded record; next record is valid
  reducer.pushChunk('\n{"id":2}\n', l => lines.push(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"id":1}');
  assert.equal(lines[1], '{"id":2}');
});

test('Phase 1 Task 1.4: StreamReducer manages message accumulation and terminal answer replacement', () => {
  const reducer = new StreamReducer({ maxTotalBytes: 500, maxMessageBytes: 200 });

  // 1. Delta accumulation
  reducer.upsertMessage('msg1', 'Part 1: Initial analysis. ', { delta: true });
  reducer.upsertMessage('msg1', 'Part 2: Findings confirmed.', { delta: true });
  assert.equal(reducer.getMessageMap().get('msg1'), 'Part 1: Initial analysis. Part 2: Findings confirmed.');

  // 2. Terminal answer replacement clears intermediate drafts and sets final
  reducer.setFinalAnswer('Comprehensive Final Architecture Report:\nAll 4 tasks completed.');
  assert.equal(reducer.getMessageMap().size, 1);
  assert.ok(reducer.getFormattedOutput().includes('Comprehensive Final Architecture Report'));
  assert.ok(!reducer.getFormattedOutput().includes('Initial analysis'));
});

test('Phase 1 Task 1.4: StreamReducer tracks activity progress and tool lifecycle', () => {
  const activities = [];
  const reducer = new StreamReducer({
    onProgress: act => activities.push(act),
  });

  reducer.recordActivity('Scanning AST nodes...');
  reducer.recordActivity('Running verification matrix...');
  assert.deepEqual(activities, ['Scanning AST nodes...', 'Running verification matrix...']);

  // Tool transitions
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'active'), true);
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'active'), false, 'Duplicate active ignored');
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'done'), true);
  assert.equal(reducer.recordTool('tool-1', 'ast_grep', 'done'), false, 'Duplicate done ignored');

  assert.equal(reducer.getActiveTools().get('tool-1'), 'ast_grep');
  assert.ok(reducer.getFinishedTools().has('tool-1'));
});

test('Phase 1 Task 1.4 Audit Remediation: StreamReducer handles multi-byte UTF-8 split across chunk buffers without corruption', () => {
  const reducer = new StreamReducer();
  const lines = [];

  // 4-byte emoji 😀 is 0xF0 0x9F 0x98 0x80
  const emojiBytes = Buffer.from('😀\n', 'utf8');
  assert.equal(emojiBytes.length, 5);

  // Split emoji across two chunks: 2 bytes in chunk 1, remaining 3 bytes in chunk 2
  reducer.pushChunk(emojiBytes.subarray(0, 2), l => lines.push(l));
  assert.equal(lines.length, 0);

  reducer.pushChunk(emojiBytes.subarray(2), l => lines.push(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '😀');
  assert.ok(!lines[0].includes('\uFFFD'), 'Must not produce replacement characters');
});

test('Phase 1 Task 1.4 Audit Remediation: records containing a newline or trailing fragments strictly enforce maxLineBuffer', () => {
  const reducer = new StreamReducer({ maxLineBuffer: 20 });
  const lines = [];

  // A 40-byte record arriving with a newline in a single chunk must be discarded
  const oversizedChunk = 'X'.repeat(40) + '\nvalid\n';
  reducer.pushChunk(oversizedChunk, l => lines.push(l));

  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'valid');
  assert.equal(reducer.hasOversizedLine(), true);

  // An oversized trailing fragment must be discarded on flush
  reducer.pushChunk('Y'.repeat(30));
  reducer.flush(l => lines.push(l));
  assert.equal(lines.length, 1, 'Trailing oversized fragment must not be emitted');
});

test('Phase 1 Task 1.4 Audit Remediation: strict byte budgets never exceed available space even with small budgets and multiple messages', () => {
  // Truncating with tiny budget (2 bytes) must never exceed 2 bytes
  const tiny = truncateToByteLength('Long text string', 2, '...[truncated]');
  assert.ok(Buffer.byteLength(tiny, 'utf8') <= 2);

  // Message budget of 10 bytes must strictly never exceed 10 bytes across multiple insertions & updates
  const reducer = new StreamReducer({ maxTotalBytes: 10, maxMessageBytes: 10 });
  reducer.upsertMessage('m1', 'Hello');
  assert.ok(reducer.getTotalBytes() <= 10);

  reducer.upsertMessage('m2', 'World 12345');
  assert.ok(reducer.getTotalBytes() <= 10, `Total bytes was ${reducer.getTotalBytes()}`);

  reducer.upsertMessage('m3', 'Third message overflow');
  assert.ok(reducer.getTotalBytes() <= 10, `Total bytes was ${reducer.getTotalBytes()}`);
  assert.ok(Buffer.byteLength(reducer.getFormattedOutput(), 'utf8') <= 10);
  assert.equal(reducer.isTruncated(), true);

  // Updating existing message under budget pressure
  reducer.upsertMessage('m1', 'Updated longer message text', { delta: true });
  assert.ok(reducer.getTotalBytes() <= 10, `Total bytes after delta was ${reducer.getTotalBytes()}`);
  assert.ok(Buffer.byteLength(reducer.getFormattedOutput(), 'utf8') <= 10);
});

test('Phase 1 Task 1.4 Audit Remediation: activity and tool state bounds prevent memory leaks', () => {
  const reducer = new StreamReducer({ maxActivities: 5, maxTools: 5 });

  for (let i = 0; i < 20; i++) {
    reducer.recordActivity(`Activity step ${i}`);
    reducer.recordTool(`tool-${i}`, `name-${i}`, 'active');
  }

  assert.ok(reducer.getActivities().length <= 5);
  assert.ok(reducer.getActiveTools().size <= 5);

  // Completion-only tool events must also strictly respect maxTools: 5
  const compReducer = new StreamReducer({ maxTools: 5 });
  for (let i = 0; i < 20; i++) {
    compReducer.recordTool(`comp-tool-${i}`, `comp-name-${i}`, 'done');
  }
  assert.ok(compReducer.getActiveTools().size <= 5, `Active tools size was ${compReducer.getActiveTools().size}`);
  assert.ok(compReducer.getFinishedTools().size <= 5, `Finished tools size was ${compReducer.getFinishedTools().size}`);
});

test('Phase 1 Task 1.4 Audit Remediation: messages exceeding maxMessages set isTruncated and throw in Gemini adapter', async () => {
  const reducer = new StreamReducer({ maxMessages: 3 });
  reducer.upsertMessage('m1', 'first');
  reducer.upsertMessage('m2', 'second');
  reducer.upsertMessage('m3', 'third');
  assert.equal(reducer.isTruncated(), false);

  // 4th message exceeds limit -> rejected and marked truncated
  reducer.upsertMessage('m4', 'fourth');
  assert.equal(reducer.isTruncated(), true);
  assert.equal(reducer.getMessageMap().size, 3);

  // Gemini adapter throws BufferLimitError when exceeding maxMessages public messages
  const { createGeminiCollector } = require('../src/backends/gemini.adapter.ts');
  const collector = createGeminiCollector();
  for (let i = 0; i < 50; i++) {
    collector.line(JSON.stringify({ type: 'message', role: 'assistant', content: `Message ${i}`, message_id: `msg-${i}` }));
  }
  assert.throws(
    () => collector.line(JSON.stringify({ type: 'message', role: 'assistant', content: 'Message 51', message_id: 'msg-51' })),
    /Too many public messages/
  );
});

test('Phase 1 Task 1.2 Audit Remediation: terminateProcessTree cleans up descendants with registered PIDs when parent has already exited', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-specific descendant teardown test');
    return;
  }

  let grandchildPid = 0;
  t.after(() => {
    if (grandchildPid > 0) {
      try { process.kill(grandchildPid); } catch {}
    }
  });

  // Spawn child that spawns a grandchild, then child exits immediately
  const childScript = "$proc = Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30' -PassThru; Write-Output $proc.Id";

  const child = spawn('powershell.exe', ['-NoProfile', '-Command', childScript], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  child.stdout.on('data', d => {
    const parsed = parseInt(d.toString().trim(), 10);
    if (!isNaN(parsed) && parsed > 0) grandchildPid = parsed;
  });

  await new Promise(r => child.on('close', r));
  assert.ok(grandchildPid > 0, 'Grandchild process was created');

  // Now terminate child tree (parent already exited)
  await terminateProcessTree(child, 250, [grandchildPid]);

  // Verify grandchild is terminated
  await new Promise(r => setTimeout(r, 500));
  let isAlive = false;
  try {
    process.kill(grandchildPid, 0);
    isAlive = true;
    try { process.kill(grandchildPid); } catch {}
  } catch {
    isAlive = false;
  }
  assert.equal(isAlive, false, 'Grandchild process should be terminated');
});

test('Phase 1 Task 1.4 Audit Remediation: joining messages under tight budget marks isTruncated true', () => {
  const reducer = new StreamReducer({ maxTotalBytes: 10, maxMessageBytes: 10 });
  reducer.upsertMessage('m1', '12345'); // 5 bytes
  reducer.upsertMessage('m2', '67890'); // 5 bytes
  assert.equal(reducer.isTruncated(), false); // individually they fit (5 + 5 = 10)
  const output = reducer.getFormattedOutput(); // joined with '\n\n' -> 12 bytes -> bounded to 10 bytes
  assert.ok(Buffer.byteLength(output, 'utf8') <= 10);
  assert.equal(reducer.isTruncated(), true, 'Joined output truncation must mark isTruncated true');
});

test('Phase 1 Task 1.2 Audit Remediation: terminateProcessTree cleans up descendants when both ancestors A and B have exited', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-specific descendant teardown test');
    return;
  }

  let childA = null;
  let bPid = 0;
  let cPid = 0;
  let stopTracking = () => {};

  t.after(async () => {
    stopTracking();
    if (childA) {
      try { await terminateProcessTree(childA); } catch {}
    }
    if (bPid > 0) { try { process.kill(bPid); } catch {} }
    if (cPid > 0) { try { process.kill(cPid); } catch {} }
  });

  // A spawns B, B spawns C (sleep 30), A and B both exit. C survives.
  const script = "$b = Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',\"`$c = Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30' -PassThru; Write-Output `$c.Id\" -PassThru; Write-Output $b.Id";

  childA = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  const { startDescendantTracking } = require('../src/execution/process.ts');
  stopTracking = startDescendantTracking(childA);

  childA.stdout.on('data', d => {
    const parsed = parseInt(d.toString().trim(), 10);
    if (!isNaN(parsed) && parsed > 0) bPid = parsed;
  });

  await new Promise(r => childA.on('close', r));
  assert.ok(bPid > 0, 'Intermediate process B was created');

  // Both ancestors will exit, test verifies automatic discovery without manual registration

  // Wait for B to spawn C and B to exit
  await new Promise(r => setTimeout(r, 1000));

  // Query C
  const { execSync } = require('node:child_process');
  for (let i = 0; i < 15 && cPid === 0; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const out = execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${bPid}\\" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId"`, { encoding: 'utf8', windowsHide: true }).trim();
      const parsed = parseInt(out, 10);
      if (!isNaN(parsed) && parsed > 0) cPid = parsed;
    } catch {}
  }

  assert.ok(cPid > 0, 'Grandchild process C was spawned and is running');

  // Both A and B are now exited! C is alive.
  // Terminate tree with retained ancestry automatically captured without manual PID registration
  stopTracking();
  await terminateProcessTree(childA);

  // Verify C is dead
  await new Promise(r => setTimeout(r, 500));
  let isAlive = false;
  try {
    process.kill(cPid, 0);
    isAlive = true;
    try { process.kill(cPid); } catch {}
  } catch {
    isAlive = false;
  }
  assert.equal(isAlive, false, 'Grandchild process C should be cleanly terminated even when both ancestors exited');
});

test('Phase 1 Task 1.2 Audit Remediation: runCommand cleanly tears down descendants when intermediate ancestor exits', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-specific descendant teardown test');
    return;
  }

  const { runCommand } = require('../src/execution/process.ts');

  // Command spawns child B, B spawns grandchild C (Start-Sleep 60), A and B both exit
  const script = '$b = Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile","-Command","`$c = Start-Process powershell -WindowStyle Hidden -ArgumentList `\"-NoProfile`\",`\"-Command`\",`\"Start-Sleep 60`\" -PassThru" -PassThru';
  const runPromise = runCommand('powershell.exe', ['-NoProfile', '-Command', script], {
    timeoutMs: 2500,
  });

  const res = await runPromise;
  assert.ok(res.status === 'completed' || res.status === 'timed_out');

  // Verify no orphaned sleep process remains with bounded poll
  let remaining = 1;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const { execSync } = require('node:child_process');
      const out = execSync('powershell -NoProfile -Command "@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -eq \'powershell.exe\' -and $_.CommandLine -like \'*Start-Sleep 60*\' }).Count"', { encoding: 'utf8', windowsHide: true }).trim();
      const parsed = parseInt(out, 10);
      remaining = isNaN(parsed) ? 0 : parsed;
      if (remaining === 0) break;
    } catch {}
  }
  assert.equal(remaining, 0, 'No orphaned grandchild process should remain after runCommand finishes');
});

test('Phase 1 Task 1.2 Audit Remediation: stopping descendant tracking prevents late helper close from repopulating map', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-specific descendant tracking test');
    return;
  }
  const cp = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');

  const mockChild = new EventEmitter();
  mockChild.pid = 99999;

  const mockPs = new EventEmitter();
  mockPs.stdout = new PassThrough();
  mockPs.stderr = new PassThrough();
  mockPs.kill = () => {};

  const origSpawn = cp.spawn;
  cp.spawn = function(cmd, args) {
    if (cmd === 'powershell.exe' && args?.includes('-Command')) {
      return mockPs;
    }
    return origSpawn.apply(this, arguments);
  };

  try {
    const stop = startDescendantTracking(mockChild);

    // Wait 50ms so timer1 (25ms) fires and invokes mocked helper spawn
    await new Promise(r => setTimeout(r, 50));

    // Deliver buffered descendant output to helper stdout
    mockPs.stdout.write('54321\r\n');

    // Stop tracking and clean up map while helper output is in-flight
    stop();
    trackedDescendants.delete(mockChild);

    // Helper process emits close after tracking was stopped
    mockPs.emit('close', 0);

    assert.equal(
      trackedDescendants.has(mockChild),
      false,
      'Late helper output must not re-create trackedDescendants entry once stopped'
    );
  } finally {
    cp.spawn = origSpawn;
    trackedDescendants.delete(mockChild);
  }
});


