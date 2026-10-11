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
const { getHistoryDir } = require('../../src/sessions/history/index.ts');
const { getSessionFilePath } = require('../../src/sessions/session.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('full archive never blocks CLI launch, returns successful answer with history warning (AUD-P0-3)', async () => {
  const original = adapterRegistry.agy;
  let cliExecuted = false;

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
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

    const res = await executeTask('User prompt', 'Public question', { backend: 'agy' }, tempDir);

    assert.equal(cliExecuted, true, 'Backend CLI must have executed');
    assert.equal(res.isError, false, 'Turn must not be marked as failed');
    assert.notEqual(readResult(res).error?.code, 'PROCESS_ERROR');
    assert.notEqual(readResult(res).error?.code, 'HISTORY_ERROR');
    assert.ok(res.result.output.startsWith('Secured answer from backend'));
    assert.equal(readResult(res).answer, 'Secured answer from backend');
    assert.equal(readResult(res).historyAvailable, true, 'History must be available after LRU eviction');
    const remaining = fs.readdirSync(historyDir).filter(f => f.startsWith('syn_sess_dummy'));
    assert.ok(remaining.length < 11, 'LRU retention must have evicted oldest dummy sessions');
    assert.ok(!remaining.includes('syn_sess_dummy0000000000000000.jsonl'), 'Oldest dummy session must be evicted');
  } finally {
    adapterRegistry.agy = original;
  }
});

test('per-session limit: 120 KiB streamed answer returns successfully (AUD-P0-3)', async () => {
  const original = adapterRegistry.agy;
  const largeOutput = 'X'.repeat(120 * 1024); // 120 KiB

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const res = await executeTask('Generate 120 KiB', 'Public question', { backend: 'agy' }, tempDir);

    assert.equal(res.isError, false, '120 KiB response must return successfully');
    assert.equal(readResult(res).status, 'completed');
    assert.ok(res.result.output.startsWith(largeOutput));
    assert.equal(readResult(res).answer.length, 120 * 1024);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('metadata failure returns answer with warning and continuationAvailable=false (AUD-P1-3)', async () => {
  const original = adapterRegistry.agy;

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

    const res = await executeTask('Prompt', 'Public question', { backend: 'agy' }, tempDir);

    assert.equal(res.isError, false, 'Turn must succeed despite metadata write failure');
    assert.ok(res.result.output.startsWith('Important successfully computed answer'));
    assert.equal(readResult(res).continuationAvailable, false, 'continuationAvailable must be disabled on metadata failure');
    assert.ok(
      readResult(res).warnings.some(w => w.includes('Session update failed')),
      'Warning must report metadata failure'
    );
  } finally {
    adapterRegistry.agy = original;
  }
});

test('lease failure returns fail-closed SESSION_INVALID error (AUD-P0-3 lease invariant)', async () => {
  const original = adapterRegistry.agy;

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

    const res = await executeTask('Prompt', 'Public question', { backend: 'agy' }, tempDir);

    assert.equal(res.isError, true, 'Lease failure must fail closed');
    assert.equal(readResult(res).status, 'failed');
    assert.equal(readResult(res).error?.code, 'SESSION_INVALID', 'Must return SESSION_INVALID, not HISTORY_ERROR');
    assert.notEqual(readResult(res).error?.code, 'HISTORY_ERROR');
  } finally {
    adapterRegistry.agy = original;
  }
});

test('history disabled (coagent8_HISTORY=off) creates no history files', async () => {
  const original = adapterRegistry.agy;
  const prevHistoryEnv = process.env.coagent8_HISTORY;
  process.env.coagent8_HISTORY = 'off';

  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-no-history-'));

  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
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
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });

    const res = await executeTask('Prompt', 'Public question', { backend: 'agy' }, isolatedDir);

    assert.equal(res.isError, false);
    assert.ok(res.result.output.startsWith('No history answer'));
    assert.equal(readResult(res).historyAvailable, false);

    // Verify history directory does not exist or has no json/jsonl files
    const historyDir = path.join(isolatedDir, 'history');
    if (fs.existsSync(historyDir)) {
      const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
      assert.equal(files.length, 0, 'No history files should be created when coagent8_HISTORY=off');
    }
  } finally {
    adapterRegistry.agy = original;
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
  const original = adapterRegistry.agy;
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      for (let i = 0; i < 2; i++) options.onEvent({ type: 'warning', message: 'The agy sandbox denied an action outside the read-only profile; the answer may be incomplete.' });
      for (let i = 0; i < 10; i++) options.onEvent({ type: 'warning', message: `distinct warning ${i}` });
      return { status: 'completed', isError: false, output: 'Answer kept', nativeSessionId: randomUUID(), model: 'gemini-test', truncated: false, continuationAvailable: true };
    },
  };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const res = await executeTask('User prompt', 'Public question', { backend: 'agy' }, tempDir);
    assert.equal(res.isError, false);
    assert.equal(readResult(res).answer, 'Answer kept');
    const warnings = readResult(res).warnings;
    assert.equal(warnings.filter(w => /sandbox denied/.test(w)).length, 1, 'duplicates collapse');
    assert.equal(warnings.length, 5, 'adapter warnings are bounded');
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a top-tier model without a way to ask the user is refused in one line; user_confirmed grants nothing (AUD-P1-7)', async () => {
  const original = adapterRegistry.agy;
  let executed = false;
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async () => { executed = true; throw new Error('must not run'); } };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    const message = "Model 'claude-opus-4-6-thinking' needs the user's approval, which this client cannot ask for (no MCP elicitation). Its price is known only approximately, as anthropic/claude-opus-4.6: 25 USD per million output tokens. Tell the user; switch to another model only if the user asks. The user can approve it in a client that shows MCP forms, or allow it in governance.models.allow (VS Code: coagent8.approval.allowModels); never change that setting yourself.";
    await assert.rejects(executeTask('User prompt', 'Public question', { backend: 'agy', model: 'claude-opus-4-6-thinking' }, tempDir),
      { name: 'ToolError', code: 'POLICY_DENIED', message });
    // The audit reproduction: an agent-set flag used to start the governed model.
    await assert.rejects(executeTask('User prompt', 'Public question', { backend: 'agy', model: 'claude-opus-4-6-thinking', user_confirmed: true }, tempDir),
      { name: 'ToolError', code: 'POLICY_DENIED', message });
    assert.equal(executed, false);
  } finally {
    adapterRegistry.agy = original;
  }
});

test("consent is asked from the user for the backend's effective default model and bound to that model", async () => {
  const original = adapterRegistry.agy;
  const asked = [], received = [];
  // The fixture's own default is top-tier, as agy's interface selection can be.
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'claude-opus-4-6-thinking' } }),
    execute: async (_prompt, options) => {
      received.push(options.model);
      return { status: 'completed', isError: false, output: 'ok', nativeSessionId: randomUUID(), model: 'claude-opus-4-6-thinking', truncated: false, continuationAvailable: true };
    } };
  try {
    await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
    await assert.rejects(executeTask('p', 'q', { backend: 'agy' }, tempDir), { code: 'POLICY_DENIED' });
    const declined = async request => { asked.push(request); return { approved: false }; };
    await assert.rejects(executeTask('p', 'q', { backend: 'agy' }, tempDir, null, null, { askConsent: declined }),
      { code: 'POLICY_DENIED', message: "The user did not approve model 'claude-opus-4-6-thinking'. Ask the user before using another model." });
    assert.deepEqual(received, [], 'nothing runs without approval');
    const approved = async request => { asked.push(request); return { approved: true }; };
    const res = await executeTask('p', 'q', { backend: 'agy' }, tempDir, null, null, { askConsent: approved });
    assert.equal(res.isError, false);
    assert.deepEqual(received, ['claude-opus-4-6-thinking']);
    assert.deepEqual(asked.map(({ backend, model }) => ({ backend, model })), [{ backend: 'agy', model: 'claude-opus-4-6-thinking' }, { backend: 'agy', model: 'claude-opus-4-6-thinking' }]);
    assert.match(asked[0].reason, /approximately, as anthropic\/claude-opus-4\.6/, 'the user sees why');
    // A model the policy does not price as expensive never prompts.
    await executeTask('p', 'q', { backend: 'agy', model: 'gemini-3.8-flash-high' }, tempDir, null, null, { askConsent: async () => { throw new Error('must not ask'); } });
    assert.deepEqual(received, ['claude-opus-4-6-thinking', 'gemini-3.8-flash-high']);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a continuation reuses the model and effort of its session unless the call names a model', async () => {
  const original = adapterRegistry.agy;
  const seen = [];
  adapterRegistry.agy = { id: 'agy', name: 'fixture', probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      seen.push({ model: options.model, effort: options.reasoningEffort });
      return { status: 'completed', isError: false, output: 'ok', nativeSessionId: randomUUID(), model: options.model, truncated: false, continuationAvailable: true };
    } };
  try {
    const first = readResult(await executeTask('p', 'q', { backend: 'agy', model: 'gemini-3.8-flash', reasoning_effort: 'low' }, tempDir));
    for (const args of [{}, { reasoning_effort: 'high' }, {}, { model: 'gemini-3.7-flash' }]) {
      assert.equal(readResult(await executeTask('p', 'q', { session_handle: first.sessionHandle, ...args }, tempDir)).error, null);
    }
    assert.deepEqual(seen, [
      { model: 'gemini-3.8-flash', effort: 'low' },
      // AX retest of 2026-10-07: the continuation reached agy with --effort "" and failed.
      { model: 'gemini-3.8-flash', effort: 'low' },
      { model: 'gemini-3.8-flash', effort: 'high' },
      { model: 'gemini-3.8-flash', effort: 'high' },
      // Another model does not inherit an effort it may not accept.
      { model: 'gemini-3.7-flash', effort: undefined },
    ]);
  } finally {
    adapterRegistry.agy = original;
  }
});
