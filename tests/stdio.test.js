const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { connect } = require('./helpers/stdio.cjs');
const fixture = path.join(__dirname, 'fixtures/rpc-cli/rpc.cjs');
test('MCP harness bounds pending requests and awaits cleanup on malformed output, exit, spawn error and deadline', async () => {
  for (const mode of ['malformed', 'exit', 'hang', 'missing']) {
    const connection = mode === 'missing' ? connect('coagent8-synthetic-missing-executable', [])
      : connect(process.execPath, [fixture, mode], { timeoutMs: 1500 });
    try {
      await assert.rejects(connection.request('probe', {}), /MCP/);
      assert.equal(connection.pending.size, 0);
    } finally { await connection.cleanup(); }
  }
});
