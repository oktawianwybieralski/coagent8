const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { withStdioRpc } = require('../src/integrations/rpc.ts');
const fixture = path.resolve(__dirname, 'fixtures/rpc-cli/rpc.cjs');
test('installation RPC rejects pending requests on failure, deadline, and trailing malformed records', async () => {
  for (const mode of ['exit', 'malformed', 'malformed-last', 'partial-last', 'hang']) {
    await assert.rejects(withStdioRpc(process.execPath, [fixture, mode], rpc => rpc.request('probe', {}), { timeoutMs: 1500 }), /Probe|probe/);
  }
  const result = await withStdioRpc(process.execPath, [fixture, 'success'], rpc => rpc.request('probe', {}));
  assert.deepEqual(result, { synthetic: true });
});
