'use strict';

/**
 * #211: the MCP server asks for host execution once, before any tool that can start a model turn.
 *
 * Verifies, through a real MCP client over an in-memory transport:
 * - A client without forms is refused with a way out, and no turn starts.
 * - A declined, cancelled or unchecked form refuses, records nothing and starts no turn.
 * - An accepted form with the box checked records the consent; the turn runs, and the next call asks nothing.
 * - Calls that start no turn (session, doctor) ask nothing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-mcp-host-consent-'));
process.env.coagent8_DIR = tempDir;
delete process.env.COAGENT8_HOST_EXECUTION;

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ElicitRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { createServer } = require('../../src/mcp/server.ts');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { loadConfig, saveConfig, getConfigFile } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

let turns = 0;
const original = adapterRegistry.agy;
test.before(() => {
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async (_prompt, options) => {
      turns++;
      options.onEvent({ type: 'assistant_message', messageId: `m${turns}`, text: 'OK' });
      return {
        status: 'completed',
        isError: false,
        output: 'OK',
        nativeSessionId: `11111111-2222-3333-4444-${String(turns).padStart(12, '0')}`,
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
});
test.after(() => {
  adapterRegistry.agy = original;
});

async function connect(answer) {
  fs.rmSync(getConfigFile(), { force: true });
  await saveConfig({ defaultBackend: 'agy', routing: { strategy: 'fixed', allowedBackends: ['agy'] } });
  const server = createServer();
  const client = new Client({ name: 'consent-client', version: '1' }, answer ? { capabilities: { elicitation: { form: {} } } } : {});
  const asked = [];
  if (answer)
    client.setRequestHandler(ElicitRequestSchema, async request => {
      asked.push(request.params.message);
      return answer;
    });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const consult = async () =>
    readResult(await client.callTool({ name: 'consult', arguments: { proposal: 'Question?', workspace_path: tempDir } }));
  return { client, server, asked, consult, close: async () => (await client.close(), await server.close()) };
}

test('a client without forms is refused with a way out, and no turn starts', async () => {
  const c = await connect(null);
  try {
    const before = turns;
    const result = await c.consult();
    assert.equal(result.error.code, 'POLICY_DENIED');
    assert.match(result.error.message, /hostExecution/);
    assert.equal(turns, before);
    assert.equal(loadConfig().hostExecution, undefined);
  } finally {
    await c.close();
  }
});

test('a declined, cancelled or unchecked form refuses, records nothing and starts no turn', async () => {
  for (const answer of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { approve: false } }]) {
    const c = await connect(answer);
    try {
      const before = turns;
      const result = await c.consult();
      assert.equal(result.error.code, 'POLICY_DENIED', JSON.stringify(answer));
      assert.equal(c.asked.length, 1);
      assert.match(c.asked[0], /without a sandbox/);
      assert.equal(turns, before);
      assert.equal(loadConfig().hostExecution, undefined);
    } finally {
      await c.close();
    }
  }
});

test('an accepted form records the consent, the turn runs, and the next call asks nothing', async () => {
  const c = await connect({ action: 'accept', content: { approve: true } });
  try {
    const before = turns;
    const first = await c.consult();
    assert.ok(!first.error, JSON.stringify(first.error));
    assert.equal(turns, before + 1);
    assert.equal(loadConfig().hostExecution, 'accepted');
    await c.consult();
    assert.equal(c.asked.length, 1, 'asked once');
    assert.equal(turns, before + 2);
  } finally {
    await c.close();
  }
});

test('calls that start no turn ask nothing', async () => {
  const c = await connect({ action: 'accept', content: { approve: true } });
  try {
    await c.client.callTool({ name: 'session', arguments: { action: 'list', workspace_path: tempDir } });
    assert.equal(c.asked.length, 0);
    assert.equal(loadConfig().hostExecution, undefined);
  } finally {
    await c.close();
  }
});

test('a call that still passes coordinate is refused with its replacement before anything else (#212)', async () => {
  const c = await connect(null);
  try {
    const result = readResult(
      await c.client.callTool({ name: 'delegate', arguments: { task: 'Do it', coordinate: true, workspace_path: tempDir } }),
    );
    assert.equal(result.error.code, 'INPUT_LIMIT');
    assert.match(result.error.message, /coordinate was removed: start the workers yourself with delegate and root_handle/);
  } finally {
    await c.close();
  }
});
