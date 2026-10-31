const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createProgressReporter } = require('../../src/mcp/progress.ts');

test('the progress reporter redacts each message where it leaves for the client (SIMPLIFY-001)', () => {
  const sent = [];
  const report = createProgressReporter(
    {
      notification: async notification => {
        sent.push(notification.params.message);
      },
    },
    'token',
    0,
  );
  const home = path.join(os.homedir(), 'project', 'file.ts');
  report({ message: `Running: Read ${home}` });
  report(`Warning: token=abc123secretvalue in ${home}`);
  report.close();
  assert.equal(sent.length, 2);
  for (const message of sent) {
    assert.ok(!message.includes(os.homedir()), message);
    assert.ok(!message.includes('abc123secretvalue'), message);
  }
});
