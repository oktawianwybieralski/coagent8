'use strict';

/**
 * EXEC-001-T10a: Consent cancellation, deadline binding, and identity verification.
 *
 * Verifies:
 * - Delayed consent reply past monotonic execution deadline rejects with TIMEOUT.
 * - Form cancellation or unanswering rejects with POLICY_DENIED and never remembers approval.
 * - Caller abort signal during consent wait rejects immediately with ABORTED.
 * - Response identity binding: mismatched model or backend rejects with POLICY_DENIED.
 * - Neither delayed replies, cancelled forms, nor declined requests invoke adapter execution.
 * - Server MCP elicitation uses dynamic execution budget deadline instead of static 5 minutes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-controller-consent-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { prepareTask, confirmTaskConsent } = require('../../src/execution/preparation.ts');
const { createExecutionBudget } = require('../../src/execution/runtime/budget.ts');
const { saveConfig, loadConfig } = require('../../src/config.ts');
const { ToolError } = require('../../src/contracts/error.ts');
const { createServer } = require('../../src/mcp/server.ts');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { readResult } = require('../helpers/result.cjs');

const originalRegistry = {
  codex: adapterRegistry.codex,
  agy: adapterRegistry.agy,
  claude: adapterRegistry.claude,
};

test.after(() => {
  Object.assign(adapterRegistry, originalRegistry);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function setupMockConfigAndAdapters() {
  saveConfig({
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'agy'] },
    governance: {
      priceMultiplier: 2,
      askAbovePrice: 20,
      alwaysAsk: ['claude-opus-4-6-thinking', 'gpt-expensive'],
      neverAsk: [],
    },
  });

  adapterRegistry.codex = {
    id: 'codex',
    name: 'fixture',
    probe: async () => ({
      installed: true,
      executionSupported: true,
      version: '1.0.0',
      config: { defaultModel: 'gpt-6.1-sol' },
    }),
    listModels: async () => ({
      source: 'codex-catalog',
      models: [
        { id: 'gpt-6.1-sol', efforts: ['low'], isDefault: true },
        { id: 'gpt-expensive', efforts: ['low'], isDefault: false },
        { id: 'gpt-unknown', efforts: ['low'], isDefault: false },
      ],
    }),
    execute: async (_prompt, options) => ({
      status: 'completed',
      isError: false,
      output: `executed with ${options.model}`,
      nativeSessionId: randomUUID(),
      model: options.model,
      truncated: false,
      continuationAvailable: true,
    }),
  };
}

test('confirmConsent: delayed reply after budget deadline throws TIMEOUT and does not remember approval', async () => {
  setupMockConfigAndAdapters();
  let fakeNow = 1000;
  const clock = () => fakeNow;
  const budget = createExecutionBudget({ totalBudgetMs: 5000, teardownAllowanceMs: 1000, clock });

  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir, { budget });

  // Simulate user answering only after monotonic clock advances past deadline (deadline = 1000 + 4000 = 5000)
  await assert.rejects(
    prepared.confirmConsent({
      budget,
      askConsent: async () => {
        fakeNow = 6000; // Monotonic deadline exceeded!
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      assert.match(err.message, /Execution budget expired during waiting for user consent/);
      return true;
    }
  );

  // Crucial check: approval must NOT have been saved into configuration
  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.neverAsk.includes('gpt-expensive'), 'Late approval must not be remembered');
});

test('confirmConsent: caller abort signal during consent wait throws ABORTED and does not remember approval', async () => {
  setupMockConfigAndAdapters();
  const ac = new AbortController();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  await assert.rejects(
    prepared.confirmConsent({
      abortSignal: ac.signal,
      askConsent: async () => {
        ac.abort();
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'ABORTED');
      assert.match(err.message, /Request cancelled during waiting for user consent/);
      return true;
    }
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.neverAsk.includes('gpt-expensive'), 'Cancelled approval must not be remembered');
});

test('confirmConsent: pending callback that never resolves rejects immediately upon caller abort', async () => {
  setupMockConfigAndAdapters();
  const ac = new AbortController();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  let callbackStarted = false;
  const consentPromise = prepared.confirmConsent({
    abortSignal: ac.signal,
    askConsent: async () => {
      callbackStarted = true;
      return new Promise(() => {}); // pending forever
    },
  });

  while (!callbackStarted) {
    await new Promise(r => setTimeout(r, 5));
  }

  ac.abort();

  await assert.rejects(consentPromise, err => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'ABORTED');
    assert.match(err.message, /Request cancelled during waiting for user consent/);
    return true;
  });

  assert.ok(!loadConfig().governance.neverAsk.includes('gpt-expensive'), 'Pending aborted callback must not remember approval');
});

test('confirmConsent: pending callback that never resolves rejects immediately upon budget timeout', async () => {
  setupMockConfigAndAdapters();
  const budget = createExecutionBudget({ totalBudgetMs: 50, teardownAllowanceMs: 10 });
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir, { budget });

  const consentPromise = prepared.confirmConsent({
    budget,
    askConsent: async () => new Promise(() => {}), // pending forever
  });

  await assert.rejects(consentPromise, err => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.message, /Execution budget expired during waiting for user consent/);
    return true;
  });

  assert.ok(!loadConfig().governance.neverAsk.includes('gpt-expensive'), 'Pending timed-out callback must not remember approval');
});

test('confirmConsent: conflicting response with approved: true and unanswered: true rejects with POLICY_DENIED', async () => {
  setupMockConfigAndAdapters();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  await assert.rejects(
    prepared.confirmConsent({
      askConsent: async () => ({ approved: true, unanswered: true, remember: true }),
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /The client closed the approval request for model 'gpt-expensive' without an answer/);
      return true;
    }
  );

  assert.ok(!loadConfig().governance.neverAsk.includes('gpt-expensive'), 'Conflicting unanswered response must not remember approval');
});

test('confirmConsent: cancelled form (unanswered) throws POLICY_DENIED with unanswered message', async () => {
  setupMockConfigAndAdapters();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  await assert.rejects(
    prepared.confirmConsent({
      askConsent: async () => ({ approved: false, unanswered: true, remember: true }),
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /The client closed the approval request for model 'gpt-expensive' without an answer/);
      return true;
    }
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.neverAsk.includes('gpt-expensive'), 'Unanswered approval must not be remembered');
});

test('confirmConsent: user decline throws POLICY_DENIED with user did not approve message', async () => {
  setupMockConfigAndAdapters();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  await assert.rejects(
    prepared.confirmConsent({
      askConsent: async () => ({ approved: false, unanswered: false }),
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /The user did not approve model 'gpt-expensive'/);
      return true;
    }
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.neverAsk.includes('gpt-expensive'), 'Declined approval must not be remembered');
});

test('confirmConsent: response identity mismatch (wrong model or backend) throws POLICY_DENIED', async () => {
  setupMockConfigAndAdapters();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  // Mismatched model
  await assert.rejects(
    prepared.confirmConsent({
      askConsent: async () => ({ approved: true, model: 'different-model', backend: 'codex' }),
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /Consent response mismatch: expected approval for model 'gpt-expensive' on codex/);
      return true;
    }
  );

  // Mismatched backend
  await assert.rejects(
    prepared.confirmConsent({
      askConsent: async () => ({ approved: true, model: 'gpt-expensive', backend: 'agy' }),
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /Consent response mismatch: expected approval for model 'gpt-expensive' on codex/);
      return true;
    }
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.neverAsk.includes('gpt-expensive'), 'Mismatched approval must not be remembered');
});

test('executeTask: delayed consent reply past budget deadline blocks turn execution', async () => {
  setupMockConfigAndAdapters();
  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  let fakeNow = 1000;
  const clock = () => fakeNow;
  const budget = createExecutionBudget({ totalBudgetMs: 4000, teardownAllowanceMs: 1000, clock });

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, null, null, {
      budget,
      askConsent: async () => {
        fakeNow = 5000; // past execution deadline (3000 ms allowance)
        return { approved: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    }
  );

  assert.equal(executionRan, false, 'Turn must never execute when consent reply is delayed past deadline');
});

test('executeTask: abort signal during consent blocks turn execution and leaves config untouched', async () => {
  setupMockConfigAndAdapters();
  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  const ac = new AbortController();

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, ac.signal, null, {
      askConsent: async () => {
        ac.abort();
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'ABORTED');
      return true;
    }
  );

  assert.equal(executionRan, false, 'Turn must never execute when consent is aborted');
  assert.ok(!loadConfig().governance.neverAsk.includes('gpt-expensive'));
});

test('MCP server: binds elicitInput timeout to execution budget and cancels cleanly', async () => {
  setupMockConfigAndAdapters();
  let executedModel = null;
  adapterRegistry.codex.execute = async (_prompt, options) => {
    executedModel = options.model;
    return {
      status: 'completed',
      isError: false,
      output: 'mcp-approved-answer',
      nativeSessionId: randomUUID(),
      model: options.model,
      truncated: false,
      continuationAvailable: true,
    };
  };

  const server = createServer();
  const client = new Client({ name: 'consent-test-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    let elicitHandler = async () => ({ action: 'decline' });
    client.setRequestHandler(ElicitRequestSchema, async req => elicitHandler(req));

    // 1. Client cancels form (unanswered)
    elicitHandler = async () => ({ action: 'cancel' });
    const cancelRes = readResult(
      await client.callTool({
        name: 'consult',
        arguments: { proposal: 'q', model: 'gpt-expensive', workspace_path: tempDir },
      })
    );
    assert.equal(cancelRes.error?.code, 'POLICY_DENIED');
    assert.match(cancelRes.error?.message, /without an answer/);
    assert.equal(executedModel, null, 'Cancelled form must not execute turn');

    // 2. Client unchecks approve box
    elicitHandler = async () => ({ action: 'accept', content: { approve: false } });
    const uncheckRes = readResult(
      await client.callTool({
        name: 'consult',
        arguments: { proposal: 'q', model: 'gpt-expensive', workspace_path: tempDir },
      })
    );
    assert.equal(uncheckRes.error?.code, 'POLICY_DENIED');
    assert.match(uncheckRes.error?.message, /did not approve/);
    assert.equal(executedModel, null, 'Unchecked box must not execute turn');

    // 3. Client approves and remembers (using unpriced model offering remember)
    elicitHandler = async () => ({ action: 'accept', content: { approve: true, remember: true } });
    const approvedRes = readResult(
      await client.callTool({
        name: 'consult',
        arguments: { proposal: 'q', model: 'gpt-unknown', workspace_path: tempDir },
      })
    );
    assert.equal(approvedRes.answer, 'mcp-approved-answer');
    assert.equal(executedModel, 'gpt-unknown');
    assert.ok(loadConfig().governance.neverAsk.includes('gpt-unknown'), 'Approved model was remembered in config');
    // 4. Elicitation timeout (e.g. client unresponsive past budget)
    elicitHandler = async () => {
      const err = new Error('Request timed out');
      err.code = -32001;
      throw err;
    };
    const timeoutRes = readResult(
      await client.callTool({
        name: 'consult',
        arguments: { proposal: 'q', model: 'gpt-expensive', workspace_path: tempDir },
      })
    );
    assert.equal(timeoutRes.error?.code, 'TIMEOUT');
    assert.match(timeoutRes.error?.message, /timed out/);

    // 5. Caller abort during elicitation
    const callAbort = new AbortController();
    elicitHandler = async () => {
      callAbort.abort();
      await new Promise(r => setTimeout(r, 10));
      return { action: 'accept', content: { approve: true } };
    };
    const abortServerRes = await server._requestHandlers.get('tools/call')(
      {
        method: 'tools/call',
        params: { name: 'consult', arguments: { proposal: 'q', model: 'gpt-expensive', workspace_path: tempDir } },
      },
      { signal: callAbort.signal }
    );
    const abortRes = readResult(abortServerRes);
    assert.equal(abortRes.error?.code, 'ABORTED');
    assert.match(abortRes.error?.message, /cancelled/i);
  } finally {
    await client.close();
    await server.close();
  }
});
