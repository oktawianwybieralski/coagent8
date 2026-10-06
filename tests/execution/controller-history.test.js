const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-controller-history-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { getHistoryDir } = require('../../src/sessions/history.ts');
const { getSessionFilePath } = require('../../src/sessions/session.ts');
const { saveConfig } = require('../../src/config.ts');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('full archive never blocks CLI launch, returns successful answer with history warning (AUD-P0-3)', async () => {
  const original = adapterRegistry.gemini;
  let cliExecuted = false;

  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async (_prompt, options) => {
      cliExecuted = true;
      options.onEvent({ type: 'assistant_message', messageId: 'm1', text: 'Secured answer from backend' });
      return {
        status: 'completed',
        isError: false,
        output: 'Secured answer from backend',
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'gemini-test',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const historyDir = getHistoryDir();
    fs.mkdirSync(historyDir, { recursive: true });

    // Pre-fill history directory above TOTAL_LIMIT (100 MiB) with sessions younger than 7 days
    const now = Date.now();
    for (let i = 0; i < 11; i++) {
      const dummyHandle = `syn_sess_dummy000000000000000${i.toString(16)}`;
      const dummyFile = path.join(historyDir, `${dummyHandle}.jsonl`);
      const fd = fs.openSync(dummyFile, 'w');
      fs.ftruncateSync(fd, 10 * 1024 * 1024); // 10 MiB each = 110 MiB total
      fs.closeSync(fd);
      // Give each dummy file an older mtime (dummy 0 is oldest, dummy 10 is newest)
      const mtime = new Date(now - (11 - i) * 60 * 1000);
      fs.utimesSync(dummyFile, mtime, mtime);
    }

    const res = await executeTask('User prompt', 'Public question', { backend: 'gemini' }, tempDir);

    assert.equal(cliExecuted, true, 'Backend CLI must have executed');
    assert.equal(res.isError, false, 'Turn must not be marked as failed');
    assert.notEqual(res.structuredContent.error?.code, 'PROCESS_ERROR');
    assert.notEqual(res.structuredContent.error?.code, 'HISTORY_ERROR');
    assert.ok(res.content[0].text.startsWith('Secured answer from backend'));
    assert.equal(res.structuredContent.output, 'Secured answer from backend');
    assert.equal(res.structuredContent.historyAvailable, undefined, 'History must be available after LRU eviction (the field appears only when false)');
    const remaining = fs.readdirSync(historyDir).filter(f => f.startsWith('syn_sess_dummy'));
    assert.ok(remaining.length < 11, 'LRU retention must have evicted oldest dummy sessions');
    assert.ok(!remaining.includes('syn_sess_dummy0000000000000000.jsonl'), 'Oldest dummy session must be evicted');
  } finally {
    adapterRegistry.gemini = original;
  }
});

test('per-session limit: 120 KiB streamed answer returns successfully (AUD-P0-3)', async () => {
  const original = adapterRegistry.gemini;
  const largeOutput = 'X'.repeat(120 * 1024); // 120 KiB

  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async (_prompt, options) => {
      options.onEvent({ type: 'assistant_delta', messageId: 'm1', text: largeOutput });
      return {
        status: 'completed',
        isError: false,
        output: largeOutput,
        nativeSessionId: '22222222-3333-4444-5555-666666666666',
        model: 'gemini-large',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const res = await executeTask('Generate 120 KiB', 'Public question', { backend: 'gemini' }, tempDir);

    assert.equal(res.isError, false, '120 KiB response must return successfully');
    assert.equal(res.structuredContent.status, 'completed');
    assert.ok(res.content[0].text.startsWith(largeOutput));
    assert.equal(res.structuredContent.output.length, 120 * 1024);
  } finally {
    adapterRegistry.gemini = original;
  }
});

test('metadata failure returns answer with warning and continuationAvailable=false (AUD-P1-3)', async () => {
  const original = adapterRegistry.gemini;

  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async (_prompt, options) => {
      options.onEvent({ type: 'assistant_message', messageId: 'm1', text: 'Important successfully computed answer' });
      return {
        status: 'completed',
        isError: false,
        output: 'Important successfully computed answer',
        // Provide an invalid threadId that causes updateSession to reject with validation error
        nativeSessionId: 'INVALID_NON_UUID_THREAD_ID',
        model: 'gemini-test',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });

    const res = await executeTask('Prompt', 'Public question', { backend: 'gemini' }, tempDir);

    assert.equal(res.isError, false, 'Turn must succeed despite metadata write failure');
    assert.ok(res.content[0].text.startsWith('Important successfully computed answer'));
    assert.equal(res.structuredContent.continuationAvailable, undefined, 'continuationAvailable must be disabled on metadata failure (the field appears only when true)');
    assert.ok(
      res.structuredContent.warnings.some(w => w.includes('Session update failed')),
      'Warning must report metadata failure'
    );
  } finally {
    adapterRegistry.gemini = original;
  }
});

test('lease failure returns fail-closed SESSION_INVALID error (AUD-P0-3 lease invariant)', async () => {
  const original = adapterRegistry.gemini;

  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async (_prompt, _options) => {
      // Simulate external concurrent process or file mutation invalidating the turn lease
      // We mutate all active session files in sessions dir to have a mismatched turnToken
      const sessionsDir = path.join(tempDir, 'sessions');
      if (fs.existsSync(sessionsDir)) {
        for (const file of fs.readdirSync(sessionsDir)) {
          if (file.endsWith('.json')) {
            const filePath = path.join(sessionsDir, file);
            try {
              const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              record.turnToken = 'different-token-causing-lease-mismatch';
              fs.writeFileSync(filePath, JSON.stringify(record));
            } catch {}
          }
        }
      }
      return {
        status: 'completed',
        isError: false,
        output: 'Some answer',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };

  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });

    const res = await executeTask('Prompt', 'Public question', { backend: 'gemini' }, tempDir);

    assert.equal(res.isError, true, 'Lease failure must fail closed');
    assert.equal(res.structuredContent.status, 'failed');
    assert.equal(res.structuredContent.error?.code, 'SESSION_INVALID', 'Must return SESSION_INVALID, not HISTORY_ERROR');
    assert.notEqual(res.structuredContent.error?.code, 'HISTORY_ERROR');
  } finally {
    adapterRegistry.gemini = original;
  }
});

test('history disabled (coagent8_HISTORY=off) creates no history files', async () => {
  const original = adapterRegistry.gemini;
  const prevHistoryEnv = process.env.coagent8_HISTORY;
  process.env.coagent8_HISTORY = 'off';

  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-no-history-'));

  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async () => ({
      status: 'completed',
      isError: false,
      output: 'No history answer',
      truncated: false,
      continuationAvailable: false,
    }),
  };

  try {
    process.env.coagent8_DIR = isolatedDir;
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });

    const res = await executeTask('Prompt', 'Public question', { backend: 'gemini' }, isolatedDir);

    assert.equal(res.isError, false);
    assert.ok(res.content[0].text.startsWith('No history answer'));
    assert.equal(res.structuredContent.historyAvailable, false);

    // Verify history directory does not exist or has no json/jsonl files
    const historyDir = path.join(isolatedDir, 'history');
    if (fs.existsSync(historyDir)) {
      const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
      assert.equal(files.length, 0, 'No history files should be created when coagent8_HISTORY=off');
    }
  } finally {
    adapterRegistry.gemini = original;
    if (prevHistoryEnv !== undefined) {
      process.env.coagent8_HISTORY = prevHistoryEnv;
    } else {
      delete process.env.coagent8_HISTORY;
    }
    process.env.coagent8_DIR = tempDir;
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test('adapter warnings such as a sandbox denial reach the result once each, with the answer kept', async () => {
  const original = adapterRegistry.gemini;
  adapterRegistry.gemini = {
    id: 'gemini',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async (_prompt, options) => {
      for (let i = 0; i < 2; i++) options.onEvent({ type: 'warning', message: 'The agy sandbox denied an action outside the read-only profile; the answer may be incomplete.' });
      for (let i = 0; i < 10; i++) options.onEvent({ type: 'warning', message: `distinct warning ${i}` });
      return { status: 'completed', isError: false, output: 'Answer kept', nativeSessionId: randomUUID(), model: 'gemini-test', truncated: false, continuationAvailable: true };
    },
  };
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const res = await executeTask('User prompt', 'Public question', { backend: 'gemini' }, tempDir);
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.output, 'Answer kept');
    const warnings = res.structuredContent.warnings;
    assert.equal(warnings.filter(w => /sandbox denied/.test(w)).length, 1, 'duplicates collapse');
    assert.equal(warnings.length, 5, 'adapter warnings are bounded');
  } finally {
    adapterRegistry.gemini = original;
  }
});

test('a top-tier model without consent is refused with a one-line instruction for the single retry', async () => {
  const original = adapterRegistry.gemini;
  let executed = false;
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', probe: async () => ({ installed: true, version: 'fixture' }),
    execute: async () => { executed = true; throw new Error('must not run'); } };
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    await assert.rejects(executeTask('User prompt', 'Public question', { backend: 'gemini', model: 'claude-opus-4-6-thinking' }, tempDir),
      /^Error: POLICY_DENIED: Model 'claude-opus-4-6-thinking' is top-tier: ask the user, then retry with user_confirmed: true\.$/);
    assert.equal(executed, false);
  } finally {
    adapterRegistry.gemini = original;
  }
});
