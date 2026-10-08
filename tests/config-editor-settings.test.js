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

const fileBytes = JSON.stringify({
  schemaVersion: 1,
  defaultBackend: 'claude',
  routing: { strategy: 'fixed', allowedBackends: ['codex', 'claude'] },
  backends: { codex: { defaultModel: 'file-codex' } },
  governance: { priceMultiplier: 3, askAbovePrice: 30, alwaysAsk: ['file-always'], neverAsk: ['file-never'] },
}, null, 2);

function withSettings(settings, action) {
  fs.writeFileSync(file, fileBytes);
  if (settings === undefined) delete process.env[EDITOR_SETTINGS_ENV];
  else process.env[EDITOR_SETTINGS_ENV] = typeof settings === 'string' ? settings : JSON.stringify(settings);
  try { return action(); } finally { delete process.env[EDITOR_SETTINGS_ENV]; }
}

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('without VS Code settings the file is the configuration', () => {
  for (const settings of [undefined, {}]) {
    const config = withSettings(settings, loadConfig);
    assert.equal(config.defaultBackend, 'claude');
    assert.deepEqual(config.governance.neverAsk, ['file-never']);
  }
});

test('explicit scalar settings replace file values and model lists are added to the file lists', () => {
  const config = withSettings({
    defaultBackend: 'auto',
    'routing.strategy': 'smart_quota',
    'routing.allowedBackends': ['gemini'],
    'claude.defaultModel': 'opus',
    'approval.priceMultiplier': 4,
    'approval.askAbovePrice': null,
    'approval.alwaysAskModels': ['editor-always'],
    'approval.neverAskModels': ['editor-never', 'file-never'],
  }, loadConfig);
  assert.equal(config.defaultBackend, null, 'auto is automatic selection');
  assert.deepEqual(config.routing, { strategy: 'smart_quota', allowedBackends: ['gemini'] });
  assert.deepEqual(config.backends, { codex: { defaultModel: 'file-codex' }, claude: { defaultModel: 'opus' } });
  assert.equal(config.governance.priceMultiplier, 4);
  assert.equal(config.governance.askAbovePrice, null);
  assert.deepEqual(config.governance.alwaysAsk, ['file-always', 'editor-always']);
  assert.deepEqual(config.governance.neverAsk, ['file-never', 'editor-never']);
});

test('an invalid or unknown setting refuses execution and names the VS Code setting', () => {
  const cases = [
    [{ 'approval.priceMultiplier': 1 }, /coagent8\.approval\.priceMultiplier: governance\.priceMultiplier must be a number greater than 1/],
    [{ 'routing.allowedBackends': ['other'] }, /coagent8\.routing\.allowedBackends: Invalid entry/],
    [{ 'codex.defaultModel': '-bad model' }, /coagent8\.codex\.defaultModel/],
    [{ 'approval.neverAskModels': 'gpt' }, /coagent8\.approval\.neverAskModels/],
    [{ 'governance.neverAsk': ['x'] }, /unknown setting 'governance\.neverAsk'/],
    ['[]', /must be a JSON object/],
    ['{', /not valid JSON/],
  ];
  for (const [settings, message] of cases) {
    assert.throws(() => withSettings(settings, loadConfig), error => error.code === 'POLICY_DENIED' && message.test(error.message), String(message));
    assert.match(withSettings(settings, loadConfigForDiagnostics).error, message, 'doctor reports the setting');
  }
  const combined = Array.from({ length: 200 }, (_, index) => `editor-${index}`);
  fs.writeFileSync(file, JSON.stringify({ governance: { neverAsk: Array.from({ length: 100 }, (_, index) => `file-${index}`) } }));
  process.env[EDITOR_SETTINGS_ENV] = JSON.stringify({ 'approval.neverAskModels': combined });
  try { assert.throws(() => loadConfig(), /coagent8\.approval\.neverAskModels: governance\.neverAsk must be a list of at most 256/); }
  finally { delete process.env[EDITOR_SETTINGS_ENV]; }
});

test('writes keep VS Code settings out of the file; a remembered approval stays effective', async () => {
  const settings = { defaultBackend: 'codex', 'approval.neverAskModels': ['editor-never'], 'gemini.defaultModel': 'editor-gemini' };
  fs.writeFileSync(file, fileBytes);
  process.env[EDITOR_SETTINGS_ENV] = JSON.stringify(settings);
  try {
    assert.equal(await rememberApprovedModel('approved-model'), true);
    assert.equal(await recordDefaultModel('gemini', 'detected-gemini'), false, 'a VS Code default model is not recorded over');
    assert.equal(await recordDefaultModel('claude', 'detected-claude'), true);
    setDefaultBackend('codex');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(stored.governance.neverAsk, ['file-never', 'approved-model']);
    assert.deepEqual(stored.backends, { codex: { defaultModel: 'file-codex' }, claude: { defaultModel: 'detected-claude' } });
    assert.deepEqual(stored.governance.alwaysAsk, ['file-always']);
    assert.deepEqual(loadConfig().governance.neverAsk, ['file-never', 'approved-model', 'editor-never']);
  } finally { delete process.env[EDITOR_SETTINGS_ENV]; }
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
