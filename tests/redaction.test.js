const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { redactDiagnostic } = require('../src/redaction.ts');

test('diagnostics redact raw, structured and repeatedly JSON-escaped Windows home paths before truncation', () => {
  const original = os.homedir;
  os.homedir = () => 'C:\\Users\\Synthetic User';
  try {
    const home = os.homedir();
    let input = home + '\\private\\config.json';
    for (let level = 0; level < 4; level++) {
      const output = redactDiagnostic(input);
      assert.ok(!output.includes('Synthetic User'), `encoding level ${level}`);
      assert.ok(output.includes('~'), `encoding level ${level}`);
      input = JSON.stringify({ message: input });
    }
    const structured = redactDiagnostic({ file: home + '\\private', api_key: 'synthetic-secret' });
    assert.ok(!structured.includes('Synthetic User'));
    assert.ok(!structured.includes('synthetic-secret'));
    for (const budget of [1, 16, 32]) {
      const bounded = redactDiagnostic(home + '\\private', budget);
      assert.ok(!bounded.includes('Synthetic User'));
      assert.ok(Buffer.byteLength(bounded) <= budget);
    }
    assert.ok(redactDiagnostic('C:\\Users\\Synthetic User2\\public').includes('Synthetic User2'));
    assert.ok(!redactDiagnostic(home.replace(/\\/g, '/') + '/private').includes('Synthetic User'));
  } finally { os.homedir = original; }
});
