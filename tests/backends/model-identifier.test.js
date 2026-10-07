const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-model-identifier-'));
process.env.coagent8_DIR = tempDir;

const { adapterRegistry } = require('../../src/backends/registry.ts');
const { executeTask } = require('../../src/execution/controller.ts');
const { saveConfig } = require('../../src/config.ts');

const OPTION_LIKE = ['--yolo', '-m', 'gpt 6', 'model\n--dangerously-bypass'];
// An empty model means "not requested" in the Codex and Gemini adapters; the schema rejects it first.

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('every adapter rejects an option-like model before it reaches argv (AUD-P1-6)', async () => {
  for (const id of ['codex', 'gemini', 'claude']) {
    for (const model of OPTION_LIKE) {
      const result = await adapterRegistry[id].execute('prompt', { cwd: tempDir, model });
      assert.equal(result.status, 'failed', `${id} ${JSON.stringify(model)}`);
      assert.equal(result.error.code, 'INPUT_LIMIT', `${id} ${JSON.stringify(model)}: ${result.error.message}`);
    }
  }
});

test('the controller rejects an option-like model before any backend runs (AUD-P1-6)', async () => {
  const original = adapterRegistry.gemini;
  let executed = false;
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', probe: async () => ({ installed: true, version: 'fixture', config: { defaultModel: 'fixture-model' } }),
    execute: async () => { executed = true; throw new Error('must not run'); } };
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    await assert.rejects(executeTask('prompt', 'question', { backend: 'gemini', model: '--yolo' }, tempDir), { code: 'INPUT_LIMIT' });
    assert.equal(executed, false);
  } finally {
    adapterRegistry.gemini = original;
  }
});
