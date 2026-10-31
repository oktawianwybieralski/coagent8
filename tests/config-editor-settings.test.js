'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-editor-settings-'));
const file = path.join(directory, 'config.json');
process.env.coagent8_CONFIG = file;

const { loadConfig, loadConfigForDiagnostics, rememberApprovedModel, recordDefaultModel, setDefaultBackend } = require('../src/config.ts');
const { EDITOR_SETTINGS, EDITOR_SETTINGS_ENV } = require('../src/config-overrides.ts');

const fileBytes = JSON.stringify(
  {
    schemaVersion: 1,
    defaultBackend: 'claude',
    routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude'] },
    backends: { codex: { defaultModel: 'file-codex' } },
    governance: { priceMultiplier: 3, askAbovePrice: 30, models: { allow: ['file-never'], ask: ['file-always'], deny: ['file-deny'] } },
  },
  null,
  2,
);

function withSettings(settings, action) {
  fs.writeFileSync(file, fileBytes);
  if (settings === undefined) delete process.env[EDITOR_SETTINGS_ENV];
  else process.env[EDITOR_SETTINGS_ENV] = typeof settings === 'string' ? settings : JSON.stringify(settings);
  try {
    return action();
  } finally {
    delete process.env[EDITOR_SETTINGS_ENV];
  }
}

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('without VS Code settings the file is the configuration', () => {
  for (const settings of [undefined, {}]) {
    const config = withSettings(settings, loadConfig);
    assert.equal(config.defaultBackend, 'claude');
    assert.deepEqual(config.governance.models, { allow: ['file-never'], ask: ['file-always'], deny: ['file-deny'] });
  }
});

test('explicit settings replace file values; approval rules come only from the file', () => {
  const config = withSettings(
    {
      defaultBackend: 'auto',
      'routing.strategy': 'smart_quota',
      'routing.allowedBackends': ['agy'],
      'claude.defaultModel': 'opus',
    },
    loadConfig,
  );
  assert.equal(config.defaultBackend, null, 'auto is automatic selection');
  assert.deepEqual(config.routing, { strategy: 'smart_quota', allowedBackends: ['agy'] });
  assert.deepEqual(config.backends, { codex: { defaultModel: 'file-codex' }, claude: { defaultModel: 'opus' } });
  // Every client's server reads the file, so approval rules have no VS Code setting (2026-10-11).
  assert.deepEqual(config.governance, {
    priceMultiplier: 3,
    askAbovePrice: 30,
    models: { allow: ['file-never'], ask: ['file-always'], deny: ['file-deny'] },
  });
  assert.ok(!Object.keys(EDITOR_SETTINGS).some(key => key.startsWith('approval.')), 'no approval setting is passed from VS Code');
});

test('an invalid or unknown setting refuses execution and names the VS Code setting', () => {
  const cases = [
    [{ 'routing.allowedBackends': ['other'] }, /coagent8\.routing\.allowedBackends: Invalid entry/],
    [{ 'codex.defaultModel': '-bad model' }, /coagent8\.codex\.defaultModel/],
    [{ 'approval.allowModels': ['gpt-6-astra'] }, /unknown setting 'approval\.allowModels'/],
    [{ 'governance.models.allow': ['x'] }, /unknown setting 'governance\.models\.allow'/],
    ['[]', /must be a JSON object/],
    ['{', /not valid JSON/],
  ];
  for (const [settings, message] of cases) {
    assert.throws(
      () => withSettings(settings, loadConfig),
      error => error.code === 'POLICY_DENIED' && message.test(error.message),
      String(message),
    );
    assert.match(withSettings(settings, loadConfigForDiagnostics).error, message, 'doctor reports the setting');
  }
});

test('writes keep VS Code settings out of the file; a remembered approval stays effective', async () => {
  const settings = { defaultBackend: 'codex', 'agy.defaultModel': 'editor-gemini' };
  fs.writeFileSync(file, fileBytes);
  process.env[EDITOR_SETTINGS_ENV] = JSON.stringify(settings);
  try {
    assert.equal(await rememberApprovedModel('approved-model'), true);
    assert.equal(await recordDefaultModel('agy', 'detected-gemini'), false, 'a VS Code default model is not recorded over');
    assert.equal(await recordDefaultModel('claude', 'detected-claude'), true);
    await setDefaultBackend('codex');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(stored.governance.models.allow, ['file-never', 'approved-model']);
    assert.deepEqual(stored.backends, { codex: { defaultModel: 'file-codex' }, claude: { defaultModel: 'detected-claude' } });
    assert.deepEqual(stored.governance.models.ask, ['file-always']);
    assert.deepEqual(loadConfig().governance.models.allow, ['file-never', 'approved-model']);
  } finally {
    delete process.env[EDITOR_SETTINGS_ENV];
  }
});

test('every runtime setting is contributed to VS Code under the same key, scoped to user settings', () => {
  const properties = require('../extensions/vscode/package.json').contributes.configuration.properties;
  for (const key of Object.keys(EDITOR_SETTINGS)) {
    assert.ok(properties[`coagent8.${key}`], key);
    assert.equal(properties[`coagent8.${key}`].scope, 'machine', `${key} cannot be set by a workspace`);
    assert.ok(properties[`coagent8.${key}`].markdownDescription.length > 20, `${key} is described`);
  }
});

test('every contributed setting has an editable control and a default that passes its own validation', () => {
  const properties = require('../extensions/vscode/package.json').contributes.configuration.properties;
  for (const [key, schema] of Object.entries(properties)) {
    assert.equal(typeof schema.type, 'string', `${key}: a nullable or mixed type has no Settings editor control`);
    assert.ok(Object.hasOwn(schema, 'default'), `${key} has a default`);
    if (schema.pattern) assert.match(schema.default, new RegExp(schema.pattern), `${key}: the default is shown as invalid`);
    if (schema.enum) assert.ok(schema.enum.includes(schema.default), `${key}: the default is one of the choices`);
  }
});

test('a cleared model field means no model chosen, not an invalid model', () => {
  const config = withSettings({ 'codex.defaultModel': '', 'claude.defaultModel': '' }, loadConfig);
  assert.deepEqual(config.backends, { codex: { defaultModel: 'file-codex' } });
});

test('a misspelt governance.models list refuses execution', () => {
  // A misspelt list would leave a model unrestricted.
  fs.writeFileSync(file, JSON.stringify({ governance: { models: { denny: ['gpt-6-astra'] } } }));
  assert.throws(
    () => loadConfig(),
    error =>
      error.code === 'POLICY_DENIED' && /governance\.models has unknown lists \(denny\); supported: allow, ask, deny/.test(error.message),
  );
});

test('setModelRule keeps exactly one rule per model and setPriceRules keeps the other settings', async () => {
  const { setModelRule, setPriceRules, readGovernance } = require('../src/config.ts');
  fs.writeFileSync(file, fileBytes);
  await setModelRule('file-always', 'deny', file);
  assert.deepEqual(
    readGovernance(file).models,
    { allow: ['file-never'], ask: [], deny: ['file-deny', 'file-always'] },
    'the model leaves its earlier list',
  );
  await setModelRule('new-model', 'allow', file);
  await setModelRule('file-never', null, file);
  assert.deepEqual(
    readGovernance(file).models,
    { allow: ['new-model'], ask: [], deny: ['file-deny', 'file-always'] },
    'null leaves the model to the price rules',
  );
  await assert.rejects(setModelRule('-bad model', 'allow', file), { code: 'INPUT_LIMIT' });
  await setPriceRules({ askAbovePrice: null }, file);
  await setPriceRules({ priceMultiplier: 4 }, file);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([stored.governance.askAbovePrice, stored.governance.priceMultiplier], [null, 4]);
  assert.equal(stored.defaultBackend, 'claude', 'other settings stay');
  await assert.rejects(setPriceRules({ priceMultiplier: 1 }, file), /priceMultiplier must be a number greater than 1/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).governance.priceMultiplier, 4, 'an invalid value writes nothing');
});
