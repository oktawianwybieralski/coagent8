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

async function setupMockConfigAndAdapters() {
  await saveConfig({
    defaultBackend: 'codex',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'agy'] },
    governance: {
      priceMultiplier: 2,
      askAbovePrice: 20,
      models: { allow: [], ask: ['claude-opus-4-6-thinking', 'gpt-expensive'], deny: [] },
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
  await setupMockConfigAndAdapters();
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
    },
  );

  // Crucial check: approval must NOT have been saved into configuration
  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.models.allow.includes('gpt-expensive'), 'Late approval must not be remembered');
});

test('confirmConsent: caller abort signal during consent wait throws ABORTED and does not remember approval', async () => {
  await setupMockConfigAndAdapters();
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
    },
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.models.allow.includes('gpt-expensive'), 'Cancelled approval must not be remembered');
});

test('confirmConsent: pending callback that never resolves rejects immediately upon caller abort', async () => {
  await setupMockConfigAndAdapters();
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

  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'), 'Pending aborted callback must not remember approval');
});

test('confirmConsent: pending callback that never resolves rejects immediately upon budget timeout', async () => {
  await setupMockConfigAndAdapters();
  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);
  // The budget starts at the consent wait under test, so a slow preparation cannot spend it.
  const budget = createExecutionBudget({ totalBudgetMs: 50, teardownAllowanceMs: 10 });

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

  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'), 'Pending timed-out callback must not remember approval');
});

test('confirmConsent: conflicting response with approved: true and unanswered: true rejects with POLICY_DENIED', async () => {
  await setupMockConfigAndAdapters();
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
    },
  );

  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'), 'Conflicting unanswered response must not remember approval');
});

test('confirmConsent: cancelled form (unanswered) throws POLICY_DENIED with unanswered message', async () => {
  await setupMockConfigAndAdapters();
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
    },
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.models.allow.includes('gpt-expensive'), 'Unanswered approval must not be remembered');
});

test('confirmConsent: user decline throws POLICY_DENIED with user did not approve message', async () => {
  await setupMockConfigAndAdapters();
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
    },
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.models.allow.includes('gpt-expensive'), 'Declined approval must not be remembered');
});

test('confirmConsent: response identity mismatch (wrong model or backend) throws POLICY_DENIED', async () => {
  await setupMockConfigAndAdapters();
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
    },
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
    },
  );

  const currentConfig = loadConfig();
  assert.ok(!currentConfig.governance.models.allow.includes('gpt-expensive'), 'Mismatched approval must not be remembered');
});

test('executeTask: delayed consent reply past budget deadline blocks turn execution', async () => {
  await setupMockConfigAndAdapters();
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
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when consent reply is delayed past deadline');
});

test('executeTask: abort signal during consent blocks turn execution and leaves config untouched', async () => {
  await setupMockConfigAndAdapters();
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
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when consent is aborted');
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'));
});

test('MCP server: binds elicitInput timeout to execution budget and cancels cleanly', async () => {
  await setupMockConfigAndAdapters();
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
      }),
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
      }),
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
      }),
    );
    assert.equal(approvedRes.answer, 'mcp-approved-answer');
    assert.equal(executedModel, 'gpt-unknown');
    assert.ok(loadConfig().governance.models.allow.includes('gpt-unknown'), 'Approved model was remembered in config');
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
      }),
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
      { signal: callAbort.signal },
    );
    const abortRes = readResult(abortServerRes);
    assert.equal(abortRes.error?.code, 'ABORTED');
    assert.match(abortRes.error?.message, /cancelled/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test('EXEC-001-T10b: price increase during consent wait invalidates approval, blocks turn execution and does not remember approval', async () => {
  const { recordPrices } = require('../../src/models/store.ts');
  await setupMockConfigAndAdapters();

  await recordPrices({
    fetchedAt: Date.now(),
    source: 'openrouter',
    models: {
      'gpt-expensive': { output: 10, input: 2, cachedInput: 1, matched: 'openai/gpt-expensive', exact: true },
      'gpt-6.1-sol': { output: 5, input: 1, cachedInput: 0.5, matched: 'openai/gpt-6.1-sol', exact: true },
    },
  });

  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, null, null, {
      askConsent: async () => {
        // Price of gpt-expensive increases to 35 USD while user is deciding
        await recordPrices({
          fetchedAt: Date.now(),
          source: 'openrouter',
          models: {
            'gpt-expensive': { output: 35, input: 5, cachedInput: 2.5, matched: 'openai/gpt-expensive', exact: true },
            'gpt-6.1-sol': { output: 5, input: 1, cachedInput: 0.5, matched: 'openai/gpt-6.1-sol', exact: true },
          },
        });
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(
        err.message,
        /The approval for model 'gpt-expensive' was invalidated because conditions changed while awaiting consent/i,
      );
      assert.match(err.message, /Its output price increased from 10 USD to 35 USD per million tokens/i);
      assert.match(err.message, /Retry the request to approve under current conditions/i);
      assert.match(err.message, /Tell the user; switch to another model only if the user asks/i);
      return true;
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when price increased during consent wait');
  assert.ok(
    !loadConfig().governance.models.allow.includes('gpt-expensive'),
    'Invalidated approval must never be remembered in models.allow',
  );
});

test('EXEC-001-T10b: price change exceeding output_price_below during consent wait blocks turn with PRICE_LIMIT and does not remember approval', async () => {
  const { recordPrices } = require('../../src/models/store.ts');
  await setupMockConfigAndAdapters();

  await recordPrices({
    fetchedAt: Date.now(),
    source: 'openrouter',
    models: {
      'gpt-expensive': { output: 10, input: 2, cachedInput: 1, matched: 'openai/gpt-expensive', exact: true },
      'gpt-6.1-sol': { output: 5, input: 1, cachedInput: 0.5, matched: 'openai/gpt-6.1-sol', exact: true },
    },
  });

  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive', output_price_below: 20 }, tempDir, null, null, {
      askConsent: async () => {
        // Price increases above the 20 USD limit to 25 USD
        await recordPrices({
          fetchedAt: Date.now(),
          source: 'openrouter',
          models: {
            'gpt-expensive': { output: 25, input: 5, cachedInput: 2.5, matched: 'openai/gpt-expensive', exact: true },
            'gpt-6.1-sol': { output: 5, input: 1, cachedInput: 0.5, matched: 'openai/gpt-6.1-sol', exact: true },
          },
        });
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'PRICE_LIMIT');
      assert.match(err.message, /not below 20 USD/i);
      assert.match(err.message, /It was not replaced by another model; name one below the limit/i);
      return true;
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when price exceeded output_price_below limit');
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'), 'Invalidated price limit must never remember approval');
});

test('EXEC-001-T10b: adding model to models.ask during consent wait invalidates approval, blocks turn and does not remember approval', async () => {
  await setupMockConfigAndAdapters();
  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, null, null, {
      askConsent: async () => {
        // Add gpt-unknown to models.ask while user is deciding
        const current = loadConfig();
        await saveConfig({
          ...current,
          governance: {
            ...current.governance,
            models: { ...current.governance.models, ask: [...current.governance.models.ask, 'gpt-unknown'] },
          },
        });
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(err.message, /The approval for model 'gpt-unknown' was invalidated because conditions changed while awaiting consent/i);
      assert.match(err.message, /'gpt-unknown' was added to governance\.models\.ask \(VS Code: CoAgent8: Manage Model Approvals\)/i);
      assert.match(err.message, /Retry the request to approve under current conditions/i);
      return true;
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when model added to models.ask during wait');
  assert.ok(
    !loadConfig().governance.models.allow.includes('gpt-unknown'),
    'Approval invalidated by models.ask must not be remembered in models.allow',
  );
});

test('EXEC-001-T10b: changing askAbovePrice threshold during consent wait invalidates approval and blocks turn', async () => {
  await setupMockConfigAndAdapters();
  await saveConfig({
    ...loadConfig(),
    governance: {
      ...loadConfig().governance,
      models: { allow: [], ask: [], deny: [] },
      askAbovePrice: 20,
    },
  });
  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, null, null, {
      askConsent: async () => {
        const current = loadConfig();
        await saveConfig({
          ...current,
          governance: {
            ...current.governance,
            askAbovePrice: 10, // lowered threshold from 20 to 10
          },
        });
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(
        err.message,
        /The approval for model 'gpt-expensive' was invalidated because conditions changed while awaiting consent/i,
      );
      assert.match(err.message, /governance.askAbovePrice (was lowered|changed) from 20 USD to 10 USD/i);
      assert.match(err.message, /Retry the request to approve under current conditions/i);
      return true;
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when askAbovePrice changed during consent');
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'));
});

test('EXEC-001-T10b: changing priceMultiplier threshold during consent wait invalidates approval and blocks turn', async () => {
  await setupMockConfigAndAdapters();
  await saveConfig({
    ...loadConfig(),
    governance: {
      ...loadConfig().governance,
      models: { allow: [], ask: [], deny: [] },
      priceMultiplier: 2,
    },
  });
  let executionRan = false;
  adapterRegistry.codex.execute = async () => {
    executionRan = true;
    return { status: 'completed', isError: false, output: 'should not run' };
  };

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, null, null, {
      askConsent: async () => {
        const current = loadConfig();
        await saveConfig({
          ...current,
          governance: {
            ...current.governance,
            priceMultiplier: 1.5, // lowered multiplier from 2 to 1.5
          },
        });
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      assert.match(
        err.message,
        /The approval for model 'gpt-expensive' was invalidated because conditions changed while awaiting consent/i,
      );
      assert.match(err.message, /governance.priceMultiplier (was lowered|changed) from 2 to 1.5/i);
      assert.match(err.message, /Retry the request to approve under current conditions/i);
      return true;
    },
  );

  assert.equal(executionRan, false, 'Turn must never execute when priceMultiplier changed during consent');
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-expensive'));
});

test('EXEC-001-T10b: valid consent under unchanged conditions succeeds, executes turn and remembers approval', async () => {
  await setupMockConfigAndAdapters();
  let executedModel = null;
  adapterRegistry.codex.execute = async (_prompt, options) => {
    executedModel = options.model;
    return {
      status: 'completed',
      isError: false,
      output: 'successful execution',
      nativeSessionId: randomUUID(),
      model: options.model,
      truncated: false,
      continuationAvailable: true,
    };
  };

  const res = await executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, null, null, {
    askConsent: async () => ({ approved: true, remember: true }),
  });

  assert.equal(res.isError, false);
  assert.equal(res.result.status, 'completed');
  assert.equal(executedModel, 'gpt-unknown');
  assert.ok(loadConfig().governance.models.allow.includes('gpt-unknown'), 'Valid approval was remembered in models.allow');
});

test('EXEC-001-T10b: modifying models.allow for a different model does not invalidate concurrent turn', async () => {
  await setupMockConfigAndAdapters();
  let executedModel = null;
  adapterRegistry.codex.execute = async (_prompt, options) => {
    executedModel = options.model;
    return {
      status: 'completed',
      isError: false,
      output: 'successful execution',
      nativeSessionId: randomUUID(),
      model: options.model,
      truncated: false,
      continuationAvailable: true,
    };
  };

  const res = await executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, null, null, {
    askConsent: async () => {
      // A concurrent turn remembers a different model 'gpt-other'
      const current = loadConfig();
      await saveConfig({
        ...current,
        governance: {
          ...current.governance,
          models: { ...current.governance.models, allow: [...current.governance.models.allow, 'gpt-other'] },
        },
      });
      return { approved: true, remember: false };
    },
  });

  assert.equal(res.isError, false);
  assert.equal(executedModel, 'gpt-unknown');
  assert.ok(loadConfig().governance.models.allow.includes('gpt-other'));
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-unknown'));
});

test('EXEC-001-T10b: turn for model on models.allow executes without POLICY_DENIED even if price list refreshes', async () => {
  await setupMockConfigAndAdapters();
  // Put gpt-expensive on models.allow and remove from models.ask
  const current = loadConfig();
  await saveConfig({
    ...current,
    governance: {
      ...current.governance,
      models: { allow: ['gpt-expensive'], ask: [], deny: [] },
    },
  });

  let executedModel = null;
  adapterRegistry.codex.execute = async (_prompt, options) => {
    executedModel = options.model;
    return {
      status: 'completed',
      isError: false,
      output: 'models.allow success',
      nativeSessionId: randomUUID(),
      model: options.model,
      truncated: false,
      continuationAvailable: true,
    };
  };

  // Turn does not require asking, and routine price refresh must not block turn
  const res = await executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, null, null, {
    askConsent: async () => {
      throw new Error('askConsent must not be called for model on models.allow');
    },
  });

  assert.equal(res.isError, false);
  assert.equal(executedModel, 'gpt-expensive');
});

test('EXEC-001-T10b: PRICE_LIMIT retry guidance distinguishes continuing sessions from fresh turns', async () => {
  await setupMockConfigAndAdapters();

  // Fresh turn guidance
  await assert.rejects(executeTask('prompt', 'summary', { model: 'gpt-expensive', output_price_below: 10 }, tempDir), err => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'PRICE_LIMIT');
    assert.match(err.message, /or omit model/);
    assert.ok(!err.message.includes('or start a new session'));
    return true;
  });

  // Continuing session guidance during preparation
  const sessionHandle = 'syn_sess_cont_1';
  const sessionFile = path.join(tempDir, 'sessions', `${sessionHandle}.json`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      schemaVersion: 2,
      sessionHandle,
      backend: 'codex',
      threadId: 'thread_cont',
      workspace: tempDir,
      model: 'gpt-expensive',
      reasoningEffort: 'low',
      activePid: null,
      activeTurnAt: null,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    }),
  );

  await assert.rejects(prepareTask({ session_handle: sessionHandle, output_price_below: 10 }, tempDir), err => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, 'PRICE_LIMIT');
    assert.match(err.message, /or start a new session/);
    return true;
  });

  // Continuing session guidance during consent revalidation
  const { recordPrices } = require('../../src/models/store.ts');
  await recordPrices({
    fetchedAt: Date.now(),
    source: 'openrouter',
    models: {
      'gpt-expensive': { output: 25, input: 5, cachedInput: 2.5, matched: 'openai/gpt-expensive', exact: true },
    },
  });
  const prepared = await prepareTask({ session_handle: sessionHandle, output_price_below: 30 }, tempDir);
  await assert.rejects(
    prepared.confirmConsent({
      askConsent: async () => {
        // Price exceeds 30 during consent wait
        await recordPrices({
          fetchedAt: Date.now(),
          source: 'openrouter',
          models: {
            'gpt-expensive': { output: 35, input: 5, cachedInput: 2.5, matched: 'openai/gpt-expensive', exact: true },
          },
        });
        return { approved: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'PRICE_LIMIT');
      assert.match(err.message, /or start a new session/);
      return true;
    },
  );

  // Fresh turn guidance during consent revalidation (when price exceeds limit during wait)
  await recordPrices({
    fetchedAt: Date.now(),
    source: 'openrouter',
    models: {
      'gpt-expensive': { output: 25, input: 5, cachedInput: 2.5, matched: 'openai/gpt-expensive', exact: true },
    },
  });
  const freshPrepared = await prepareTask({ model: 'gpt-expensive', output_price_below: 30 }, tempDir);
  await assert.rejects(
    freshPrepared.confirmConsent({
      askConsent: async () => {
        // Price exceeds 30 during consent wait
        await recordPrices({
          fetchedAt: Date.now(),
          source: 'openrouter',
          models: {
            'gpt-expensive': { output: 35, input: 5, cachedInput: 2.5, matched: 'openai/gpt-expensive', exact: true },
          },
        });
        return { approved: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'PRICE_LIMIT');
      assert.match(err.message, /or omit model/);
      assert.ok(!err.message.includes('or start a new session'));
      return true;
    },
  );
});

test('EXEC-001-T10b: lowering askAbovePrice or priceMultiplier does not block turn for model on models.allow', async () => {
  await setupMockConfigAndAdapters();
  const current = loadConfig();
  await saveConfig({
    ...current,
    governance: {
      ...current.governance,
      askAbovePrice: 50,
      priceMultiplier: 4,
      models: { allow: ['gpt-expensive'], ask: [], deny: [] },
    },
  });

  const prepared = await prepareTask({ model: 'gpt-expensive' }, tempDir);

  // During execution / revalidation, askAbovePrice and priceMultiplier are made much stricter
  await saveConfig({
    ...loadConfig(),
    governance: {
      ...loadConfig().governance,
      askAbovePrice: 5, // lowered from 50 to 5
      priceMultiplier: 1.2, // lowered from 4 to 1.2
    },
  });

  const res = await prepared.confirmConsent();
  assert.deepEqual(res.warnings, []);
});

test('EXEC-001-T10c: executeTask preserves valid approval when remember storage fails, redacting diagnostics (Primary Task Supremacy)', async () => {
  await setupMockConfigAndAdapters();
  let executedModel = null;
  adapterRegistry.codex.execute = async (_prompt, options) => {
    executedModel = options.model;
    return {
      status: 'completed',
      isError: false,
      output: 'primary task output',
      nativeSessionId: randomUUID(),
      model: options.model,
      truncated: false,
      continuationAvailable: true,
    };
  };

  const userHome = os.homedir();
  const sensitiveErrorMsg = `EACCES: permission denied, rename '${path.join(userHome, '.coagent8', 'config.json')}' with key token=sk-ant-secret12345678901234567890`;
  // Configuration writes replace the file through the asynchronous atomic writer (AUDIT-001-A07).
  const originalRename = fs.promises.rename;

  try {
    fs.promises.rename = async function (from, to) {
      if (typeof to === 'string' && to.includes('config.json')) {
        throw new Error(sensitiveErrorMsg);
      }
      return originalRename.apply(this, arguments);
    };

    const res = await executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, null, null, {
      askConsent: async () => ({ approved: true, remember: true }),
    });

    // Primary task executed cleanly
    assert.equal(res.isError, false);
    assert.equal(res.result.status, 'completed');
    assert.equal(executedModel, 'gpt-unknown');
    assert.equal(res.result.output, 'primary task output');

    // Warning is preserved and redacted
    const rememberWarning = res.warnings.find(w => w.includes("The approval of 'gpt-unknown' was not remembered:"));
    assert.ok(rememberWarning, 'Response warnings must contain consent remember warning');
    assert.ok(!rememberWarning.includes('sk-ant-secret12345678901234567890'), 'Credentials must be redacted');
    assert.ok(!rememberWarning.includes(userHome), 'User home path must be redacted');

    // Next-call policy consistency: disk state does not contain the model
    assert.ok(!loadConfig().governance.models.allow.includes('gpt-unknown'), 'Model must NOT be in models.allow');

    // Restore rename for the next turn verification
    fs.promises.rename = originalRename;

    // Subsequent independent call without askConsent requires consent again and rejects with POLICY_DENIED
    await assert.rejects(executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir), err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'POLICY_DENIED');
      return true;
    });
  } finally {
    fs.promises.rename = originalRename;
  }
});

test('EXEC-001-T10c: executeTask cancellation before storage rejects with ABORTED and leaves models.allow untouched', async () => {
  await setupMockConfigAndAdapters();
  let executed = false;
  adapterRegistry.codex.execute = async () => {
    executed = true;
    return { status: 'completed', isError: false, output: 'done', continuationAvailable: false, truncated: false };
  };

  const ac = new AbortController();

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, ac.signal, null, {
      askConsent: async () => {
        // Abort caller controller during consent callback before storage
        ac.abort();
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'ABORTED');
      return true;
    },
  );

  assert.equal(executed, false, 'Adapter execution must not run when cancelled');
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-unknown'), 'models.allow must remain untouched');
});

test('EXEC-001-T10c: executeTask budget timeout before storage rejects with TIMEOUT and leaves models.allow untouched', async () => {
  await setupMockConfigAndAdapters();
  let executed = false;
  adapterRegistry.codex.execute = async () => {
    executed = true;
    return { status: 'completed', isError: false, output: 'done', continuationAvailable: false, truncated: false };
  };

  let simulatedTime = 0;
  const budget = createExecutionBudget({
    totalBudgetMs: 50,
    teardownAllowanceMs: 0,
    clock: () => simulatedTime,
  });

  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, null, null, {
      budget,
      askConsent: async () => {
        // Advance monotonic clock past execution deadline before storage
        simulatedTime = 100;
        return { approved: true, remember: true };
      },
    }),
    err => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    },
  );

  assert.equal(executed, false, 'Adapter execution must not run when timed out');
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-unknown'), 'models.allow must remain untouched');
});

test('a model the user denies is refused with the reason before any approval request, catalog read or turn (owner decision of 2026-10-11)', async () => {
  await setupMockConfigAndAdapters();
  const current = loadConfig();
  await saveConfig({
    ...current,
    governance: { ...current.governance, models: { allow: ['gpt-expensive'], ask: ['gpt-expensive'], deny: ['gpt-expensive'] } },
  });
  let asked = false,
    executed = false,
    catalogReads = 0;
  const listModels = adapterRegistry.codex.listModels;
  adapterRegistry.codex.listModels = async () => {
    catalogReads++;
    return listModels();
  };
  adapterRegistry.codex.execute = async () => {
    executed = true;
    throw new Error('must not run');
  };
  const denied =
    "Model 'gpt-expensive' did not run: the user denied it in governance.models.deny (VS Code: CoAgent8: Manage Model Approvals). Only the user can remove it from that list. Tell the user; switch to another model only if the user asks.";
  const before = catalogReads;
  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-expensive' }, tempDir, null, null, {
      askConsent: async () => {
        asked = true;
        return { approved: true };
      },
    }),
    { name: 'ToolError', code: 'POLICY_DENIED', message: denied },
  );
  assert.equal(asked, false, 'deny wins over ask and allow: no form is shown');
  assert.equal(executed, false);
  assert.ok(catalogReads - before <= 1, 'only model selection read the catalog; the explicit-model check after it did not run');
  // A denied default is refused the same way when the call names no model.
  await saveConfig({ ...loadConfig(), governance: { ...loadConfig().governance, models: { allow: [], ask: [], deny: ['gpt-6.1-sol'] } } });
  await assert.rejects(executeTask('prompt', 'summary', {}, tempDir), {
    code: 'POLICY_DENIED',
    message: /^Model 'gpt-6\.1-sol' did not run: the user denied it/,
  });
  assert.equal(executed, false);
});

test('a rule naming an effort variant governs a call passing that effort separately or through its session', async () => {
  await setupMockConfigAndAdapters();
  const runs = [];
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    effortReplacesModelSuffix: true,
    probe: async () => ({ installed: true, executionSupported: true, version: '1.0.0', config: { defaultModel: 'gemini-3.8-flash-low' } }),
    listModels: async () => ({
      source: 'agy models',
      models: [{ id: 'gemini-3.8-flash', efforts: ['high', 'low'], effortRequired: true, isDefault: true }],
    }),
    execute: async (_prompt, options) => {
      runs.push(`${options.model}/${options.reasoningEffort}`);
      return {
        status: 'completed',
        isError: false,
        output: 'ok',
        nativeSessionId: randomUUID(),
        model: options.model,
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  const rules = models =>
    saveConfig({ ...loadConfig(), governance: { ...loadConfig().governance, models: { allow: [], ask: [], deny: [], ...models } } });
  const approve = async () => ({ approved: true });
  const call = { backend: 'agy', model: 'gemini-3.8-flash' };

  await rules({ deny: ['gemini-3.8-flash-high'] });
  let asked = false;
  await assert.rejects(
    executeTask('prompt', 'summary', { ...call, reasoning_effort: 'high' }, tempDir, null, null, {
      askConsent: async () => {
        asked = true;
        return { approved: true };
      },
    }),
    { code: 'POLICY_DENIED', message: /^Model 'gemini-3\.8-flash-high' did not run: the user denied it/ },
  );
  assert.equal(asked, false);
  // agy replaces a variant's effort with the one passed separately, so this runs the denied variant.
  await assert.rejects(
    executeTask('prompt', 'summary', { ...call, model: 'gemini-3.8-flash-low', reasoning_effort: 'high' }, tempDir, null, null, {
      askConsent: approve,
    }),
    { code: 'POLICY_DENIED', message: /^Model 'gemini-3\.8-flash-high' did not run/ },
  );
  const low = await executeTask('prompt', 'summary', { ...call, reasoning_effort: 'low' }, tempDir, null, null, { askConsent: approve });
  assert.equal(low.isError, false, 'another effort of the model still runs');

  await rules({ ask: ['gemini-3.8-flash-high'] });
  let reason = '';
  await executeTask('prompt', 'summary', { ...call, reasoning_effort: 'high' }, tempDir, null, null, {
    askConsent: async request => {
      reason = request.reason;
      return { approved: true };
    },
  });
  assert.match(reason, /on the user's ask list/, 'the ask rule decides, whatever the price');

  // A continuation keeps its session's effort, so a rule added since then still applies.
  await rules({});
  const first = await executeTask('prompt', 'summary', { ...call, reasoning_effort: 'high' }, tempDir, null, null, { askConsent: approve });
  await rules({ deny: ['gemini-3.8-flash-high'] });
  await assert.rejects(
    executeTask('follow up', 'follow up', { session_handle: readResult(first).sessionHandle }, tempDir, null, null, {
      askConsent: approve,
    }),
    { code: 'POLICY_DENIED', message: /^Model 'gemini-3\.8-flash-high' did not run/ },
  );

  // A variant denied while the approval is pending never runs.
  await rules({ ask: ['gemini-3.8-flash'] });
  const before = runs.length;
  let pending = false;
  await assert.rejects(
    executeTask('prompt', 'summary', { ...call, reasoning_effort: 'high' }, tempDir, null, null, {
      askConsent: async () => {
        pending = true;
        await rules({ ask: ['gemini-3.8-flash'], deny: ['gemini-3.8-flash-high'] });
        return { approved: true };
      },
    }),
    { code: 'POLICY_DENIED', message: /^Model 'gemini-3\.8-flash-high' did not run/ },
  );
  assert.ok(pending);
  assert.equal(runs.length, before, 'no turn ran after the denial');
});

test('agy asks for, remembers and runs the variant of a separately passed effort', async () => {
  await setupMockConfigAndAdapters();
  // Earlier tests recorded another agy catalog.
  fs.rmSync(path.join(tempDir, 'models.json'), { force: true });
  const runs = [];
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    effortReplacesModelSuffix: true,
    probe: async () => ({ installed: true, executionSupported: true, version: '1.0.0', config: { defaultModel: 'agy-unpriced-low' } }),
    listModels: async () => ({
      source: 'agy models',
      models: [{ id: 'agy-unpriced', efforts: ['high', 'low'], effortRequired: true, isDefault: true }],
    }),
    execute: async (_prompt, options) => {
      runs.push(`${options.model}/${options.reasoningEffort}`);
      return {
        status: 'completed',
        isError: false,
        output: 'ok',
        nativeSessionId: randomUUID(),
        model: options.model,
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  const asked = [];
  const call = () =>
    executeTask('prompt', 'summary', { backend: 'agy', model: 'agy-unpriced-low', reasoning_effort: 'high' }, tempDir, null, null, {
      askConsent: async request => {
        asked.push(request.model);
        return { approved: true, remember: true };
      },
    });
  assert.equal((await call()).isError, false);
  assert.deepEqual(asked, ['agy-unpriced-high'], 'the approval names the variant that runs');
  assert.ok(loadConfig().governance.models.allow.includes('agy-unpriced-high'));
  assert.equal((await call()).isError, false);
  assert.deepEqual(asked, ['agy-unpriced-high'], 'the remembered approval covers the repeated call');
  assert.deepEqual(runs, ['agy-unpriced-high/high', 'agy-unpriced-high/high']);
});

test('a model the user denies while the approval is pending never runs and is not remembered', async () => {
  await setupMockConfigAndAdapters();
  let executed = false;
  adapterRegistry.codex.execute = async () => {
    executed = true;
    throw new Error('must not run');
  };
  await assert.rejects(
    executeTask('prompt', 'summary', { model: 'gpt-unknown' }, tempDir, null, null, {
      askConsent: async () => {
        const current = loadConfig();
        await saveConfig({
          ...current,
          governance: { ...current.governance, models: { ...current.governance.models, deny: ['gpt-unknown'] } },
        });
        return { approved: true, remember: true };
      },
    }),
    {
      name: 'ToolError',
      code: 'POLICY_DENIED',
      message: /^Model 'gpt-unknown' did not run: the user denied it in governance\.models\.deny/,
    },
  );
  assert.equal(executed, false);
  assert.ok(!loadConfig().governance.models.allow.includes('gpt-unknown'), 'a denied model is never remembered as allowed');
});

test('MCP: a denied model sends no approval form and returns the reason to the caller', async () => {
  await setupMockConfigAndAdapters();
  const current = loadConfig();
  await saveConfig({
    ...current,
    governance: { ...current.governance, models: { ...current.governance.models, deny: ['gpt-expensive'] } },
  });
  const server = createServer();
  const client = new Client({ name: 'deny-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const forms = [];
  client.setRequestHandler(ElicitRequestSchema, async request => {
    forms.push(request.params);
    return { action: 'accept', content: { approve: true } };
  });
  try {
    const refused = readResult(
      await client.callTool({ name: 'consult', arguments: { proposal: 'x', workspace_path: tempDir, model: 'gpt-expensive' } }),
    ).error;
    assert.equal(refused.code, 'POLICY_DENIED');
    assert.match(
      refused.message,
      /^Model 'gpt-expensive' did not run: the user denied it in governance\.models\.deny \(VS Code: CoAgent8: Manage Model Approvals\)\. Only the user can remove it from that list\./,
    );
    assert.equal(forms.length, 0, 'a denied model is never offered for approval');
  } finally {
    await client.close();
    await server.close();
  }
});
