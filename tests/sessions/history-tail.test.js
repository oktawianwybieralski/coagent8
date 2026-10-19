const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tornTailOffset } = require('../../src/sessions/history/writer.ts');

// AUDIT-001-A16-A18: the torn-tail check reads the log backward in 8 KiB blocks instead of
// the whole log. The former whole-file algorithm is the oracle: same truncation for every log.
function wholeFileOracle(text) {
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
  if (lines.length === 0) return null;
  try { JSON.parse(lines[lines.length - 1].trim()); return null; } catch { /* torn */ }
  lines.pop();
  return Buffer.byteLength(lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-history-tail-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let counter = 0;
async function offsetOf(text) {
  const file = path.join(dir, `log-${counter++}.jsonl`);
  fs.writeFileSync(file, text);
  return tornTailOffset(file, fs.statSync(file).size);
}

const header = JSON.stringify({ _type: 'header', schemaVersion: 1 });
const record = n => JSON.stringify({ type: 'assistant_delta', sequence: n, text: `chunk ${n}` });
const big = (n, size) => JSON.stringify({ type: 'assistant_message', sequence: n, text: 'ż'.repeat(size) });

test('AUDIT-001-A17: the backward scan truncates exactly where the whole-file scan did', async () => {
  const cases = {
    'empty log': '',
    'only blank lines': '\n \n\r\n',
    'header only': `${header}\n`,
    'valid final record': `${header}\n${record(1)}\n`,
    'valid final record without newline': `${header}\n${record(1)}`,
    'trailing blank lines after a valid record': `${header}\n${record(1)}\n\n  \n`,
    'torn final record': `${header}\n${record(1)}\n{"type":"assist`,
    'torn final record and blank lines': `${header}\n${record(1)}\n{"type":\n\n`,
    'torn record that is the only line': '{"type":',
    'valid record larger than a block': `${header}\n${big(1, 20000)}\n`,
    'torn record larger than a block': `${header}\n${record(1)}\n${big(2, 20000).slice(0, -3)}`,
    'multibyte text across a block boundary': `${header}\n${big(1, 4095)}\n${big(2, 4100).slice(0, -2)}`,
    'CRLF line endings': `${header}\r\n${record(1)}\r\n{"torn"\r\n`,
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(await offsetOf(text), wholeFileOracle(text), name);
  }
});

test('AUDIT-001-A17: the backward scan agrees with the whole-file scan on generated logs', async () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 200; i++) {
    const parts = [header];
    const count = Math.floor(random() * 6);
    for (let n = 0; n < count; n++) parts.push(random() < 0.2 ? big(n, Math.floor(random() * 12000)) : record(n));
    let text = parts.join('\n') + (random() < 0.7 ? '\n' : '');
    if (random() < 0.5) text = text.slice(0, Math.max(0, text.length - Math.floor(random() * 30)));
    if (random() < 0.3) text += '\n'.repeat(Math.floor(random() * 3));
    assert.equal(await offsetOf(text), wholeFileOracle(text), `generated log ${i}`);
  }
});

test('AUDIT-001-A16: the check reads about one record, not the whole log', async () => {
  const lines = [header];
  for (let n = 0; n < 20000; n++) lines.push(record(n));
  const text = lines.join('\n') + '\n';
  const file = path.join(dir, 'measure.jsonl');
  fs.writeFileSync(file, text);
  const fsp = require('node:fs/promises');
  const open = fsp.open;
  let bytesRead = 0;
  fsp.open = async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => { const result = await read(...readArgs); bytesRead += result.bytesRead; return result; };
    return handle;
  };
  try {
    assert.equal(await tornTailOffset(file, fs.statSync(file).size), null);
  } finally {
    fsp.open = open;
  }
  assert.ok(text.length > 800 * 1024, `log of ${text.length} bytes`);
  assert.equal(bytesRead, 8 * 1024, `read ${bytesRead} bytes of a ${text.length}-byte log (the former scan read all of it)`);
});
