const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { manageSkills, skillSelectionForAction } = require('../../src/integrations/skill-management.ts');
const { skillRoot, disabledSkillRoot, readSkillCatalog } = require('../../src/integrations/skills.ts');
const { recoverSkillTransaction, transactSkills } = require('../../src/integrations/skill-transaction.ts');
const { readSelection, serializeSelection } = require('../../src/integrations/setup-storage.ts');
const { setupClients } = require('../../src/integrations/setup.ts');
const { cleanupClients } = require('../../src/integrations/cleanup.ts');
const { validateConfig, setBackendSkills } = require('../../src/config.ts');
const catalog = path.resolve(__dirname, '../../skills');
const names = readSkillCatalog(catalog).map(item => item.name);
function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-management-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), coagent8_DIR: path.join(home, '.coagent8'), coagent8_CONFIG: path.join(home, '.coagent8/config.json'), CODEX_CONFIG_PATH: undefined, CLAUDE_CONFIG_DIR: undefined, GEMINI_CLI_HOME: undefined, SETUP_FIXTURE_HOME: home };
  const options = { home, env, skillsSource: catalog, client: 'agy' };
  const state = path.join(home, '.coagent8/setup.json');
  return { home, env, options, state };
}
async function apply(options, action, chosen = names) {
  const current = await manageSkills(options);
  const selection = skillSelectionForAction(current.selection, chosen, action);
  const preview = await manageSkills({ ...options, selection });
  return manageSkills({ ...options, selection, apply: preview.token });
}
function file(home, client, name, disabled = false) { return path.join(disabled ? disabledSkillRoot(client, home) : skillRoot(client, home), name, 'SKILL.md'); }

test('independent install/disable/enable/uninstall preserves MCP bytes, other clients and native overrides', async t => {
  const p = profile(t), name = names[0];
  const mcp = path.join(p.home, '.gemini/config/mcp_config.json');
  fs.mkdirSync(path.dirname(mcp), { recursive: true });
  fs.writeFileSync(mcp, '{"mcpServers":{"coagent8":{"command":"keep"}},"token":"fixture"}');
  const original = fs.readFileSync(mcp);
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false);
  const status = await manageSkills(p.options);
  assert.ok(status.skills.every(item => item.state === 'absent'));
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false, 'status creates nothing');
  const first = await apply(p.options, 'install', [name]);
  assert.equal(first.skills.find(item => item.name === name).state, 'enabled');
  assert.equal(fs.readdirSync(skillRoot('agy', p.home)).length, 1, 'a single install does not install the rest of the catalog');
  const bytes = fs.readFileSync(file(p.home, 'agy', name));
  await apply({ ...p.options, client: 'claude', origin: 'vscode-extension' }, 'install');
  const native = path.join(p.home, '.claude/settings.json');
  fs.writeFileSync(native, JSON.stringify({ skillOverrides: { [name]: 'off' } }));
  const nativeBytes = fs.readFileSync(native);
  await apply(p.options, 'disable', [name]);
  assert.equal(fs.existsSync(file(p.home, 'agy', name)), false);
  assert.deepEqual(fs.readFileSync(file(p.home, 'agy', name, true)), bytes);
  assert.equal(fs.existsSync(file(p.home, 'claude', name)), true);
  await apply(p.options, 'enable', [name]);
  assert.deepEqual(fs.readFileSync(file(p.home, 'agy', name)), bytes);
  assert.equal(fs.existsSync(file(p.home, 'agy', name, true)), false);
  await apply(p.options, 'uninstall', [name]);
  assert.equal(fs.existsSync(file(p.home, 'agy', name)), false);
  assert.deepEqual(fs.readFileSync(mcp), original);
  assert.deepEqual(fs.readFileSync(native), nativeBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.env.coagent8_CONFIG)).backends.agy.skills, { installed: [], disabled: [] });
});

test('repair preserves explicit disabled and removed selections, and cleanup removes archived packages', async t => {
  const p = profile(t), fixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
  const options = { ...p.options, env: { ...p.env, AGY_PATH: fixture }, cwd: p.home, runtimeSource: path.resolve(__dirname, '../../dist/index.cjs'), clients: ['agy'], origin: 'vscode-extension' };
  await setupClients(options);
  await apply({ ...p.options, origin: 'vscode-extension' }, 'disable', [names[0]]);
  await apply(p.options, 'uninstall', names.slice(1));
  const mcp = fs.readFileSync(path.join(p.home, '.gemini/config/mcp_config.json'));
  await setupClients(options);
  assert.deepEqual(fs.readFileSync(path.join(p.home, '.gemini/config/mcp_config.json')), mcp);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0])), false);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0], true)), true);
  for (const name of names.slice(1)) assert.equal(fs.existsSync(file(p.home, 'agy', name)), false);
  const preview = await cleanupClients({ home: p.home, env: p.env, clients: ['agy'], origin: 'vscode-extension' });
  assert.equal(preview.results[0].skills[0].location, 'disabled');
  await cleanupClients({ home: p.home, env: p.env, clients: ['agy'], origin: 'vscode-extension', apply: preview.token });
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0], true)), false);
});

test('previews bind package bytes and configuration; edits and unknown names are preserved', async t => {
  const p = profile(t);
  await apply(p.options, 'install');
  const current = await manageSkills(p.options), selection = skillSelectionForAction(current.selection, [names[0]], 'disable');
  const preview = await manageSkills({ ...p.options, selection });
  fs.writeFileSync(file(p.home, 'agy', names[0]), 'user edit');
  await assert.rejects(manageSkills({ ...p.options, selection, apply: preview.token }), /preview changed/);
  const retry = await manageSkills({ ...p.options, selection });
  await assert.rejects(manageSkills({ ...p.options, selection, apply: retry.token }), /Conflicting/);
  assert.equal(fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8'), 'user edit');
  await assert.rejects(manageSkills({ ...p.options, selection: { installed: ['../outside'], disabled: [] } }), /Invalid/);
  await assert.rejects(manageSkills({ ...p.options, selection: { installed: [], disabled: [names[0]] } }), /Invalid/);
});

test('package origins coexist within one client and survive toggles; extension cleanup preserves CLI packages', async t => {
  const p = profile(t);
  await apply(p.options, 'install', [names[0]]);
  await apply({ ...p.options, origin: 'vscode-extension' }, 'install', [names[1]]);
  await apply({ ...p.options, origin: 'vscode-extension' }, 'disable', [names[0], names[1]]);
  const saved = readSelection(p.state);
  assert.deepEqual(saved.skillOwners.agy, { [names[0]]: 'cli', [names[1]]: 'vscode-extension' });
  const options = { home: p.home, env: p.env, clients: ['agy'], origin: 'vscode-extension', uninstall: true };
  const preview = await cleanupClients(options);
  await cleanupClients({ ...options, apply: preview.token });
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0], true)), true);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[1], true)), false);
  assert.equal(readSelection(p.state).skillOwners.agy[names[0]], 'cli');
});

test('emptied disabled storage is removed after enable and uninstall cleanup', async t => {
  const p = profile(t), storage = path.join(p.home, '.coagent8/disabled-skills');
  await apply(p.options, 'install');
  await apply(p.options, 'disable');
  await apply({ ...p.options, client: 'claude' }, 'install', [names[0]]);
  await apply({ ...p.options, client: 'claude' }, 'disable', [names[0]]);
  await apply(p.options, 'enable');
  assert.equal(fs.existsSync(disabledSkillRoot('agy', p.home)), false, 'enabling every package leaves no empty client storage');
  assert.equal(fs.existsSync(disabledSkillRoot('claude', p.home)), true, 'another client keeps its packages');
  await apply(p.options, 'disable', [names[0]]);
  fs.rmSync(p.env.coagent8_CONFIG);
  for (const client of ['agy', 'claude']) {
    const options = { home: p.home, env: p.env, clients: [client], uninstall: true };
    const preview = await cleanupClients(options);
    await cleanupClients({ ...options, apply: preview.token });
  }
  assert.equal(fs.existsSync(storage), false);
  assert.equal(fs.existsSync(path.join(p.home, '.coagent8')), false, 'uninstall removes the emptied ownership directory');
});

test('a package transaction rolls back failure and recovers an interrupted transition', async t => {
  const p = profile(t);
  await apply(p.options, 'install', [names[0]]);
  const before = fs.readFileSync(p.state, 'utf8'), content = fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8');
  const targets = [{ name: names[0], disabled: false, content: null }, { name: names[0], disabled: true, content }];
  assert.throws(() => transactSkills(p.home, 'agy', targets, before, () => {
    fs.unlinkSync(file(p.home, 'agy', names[0])); fs.rmdirSync(path.dirname(file(p.home, 'agy', names[0])));
    throw new Error('measured failure after package removal');
  }), /measured failure/);
  assert.equal(fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8'), content);
  assert.equal(fs.readFileSync(p.state, 'utf8'), before);
  fs.unlinkSync(file(p.home, 'agy', names[0])); fs.rmdirSync(path.dirname(file(p.home, 'agy', names[0])));
  const journal = path.join(p.home, '.coagent8/skill-transaction.json');
  fs.writeFileSync(journal, JSON.stringify({ client: 'agy', stateBefore: before, stateAfter: null, committed: false, packages: [{ name: names[0], disabled: false, before: content, after: null }] }));
  recoverSkillTransaction(p.home);
  assert.equal(fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8'), content);
  assert.equal(fs.existsSync(journal), false);
  fs.writeFileSync(journal, JSON.stringify({ client: 'agy', stateBefore: before, stateAfter: null, committed: false, packages: [{ name: names[0], disabled: false, before: content, after: null }] }));
  fs.writeFileSync(file(p.home, 'agy', names[0]), 'concurrent user edit');
  assert.throws(() => recoverSkillTransaction(p.home), /rollback stopped/);
  assert.equal(fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8'), 'concurrent user edit');
  assert.equal(fs.existsSync(journal), true);
});

test('native configuration schema validates selections and no-op apply preserves persisted bytes', async t => {
  const p = profile(t);
  for (const skills of [{ installed: [names[0], names[0]], disabled: [] }, { installed: [], disabled: [names[0]] }, { installed: ['../bad'], disabled: [] }, { installed: [], disabled: [], unknown: true }]) assert.throws(() => validateConfig({ backends: { agy: { skills } } }), /skills/);
  await apply(p.options, 'install');
  const config = fs.readFileSync(p.env.coagent8_CONFIG), state = fs.readFileSync(p.state);
  await apply(p.options, 'install');
  assert.deepEqual(fs.readFileSync(p.env.coagent8_CONFIG), config);
  assert.deepEqual(fs.readFileSync(p.state), state);
  assert.equal(serializeSelection(readSelection(p.state)), state.toString());
});

test('all client roots support full-set toggles and linked ancestors cannot redirect writes', async t => {
  const p = profile(t);
  for (const client of ['codex', 'claude', 'agy']) {
    const options = { ...p.options, client };
    await apply(options, 'install');
    await apply(options, 'disable');
    for (const name of names) { assert.equal(fs.existsSync(file(p.home, client, name)), false); assert.equal(fs.existsSync(file(p.home, client, name, true)), true); }
    await apply(options, 'enable');
    for (const name of names) { assert.equal(fs.existsSync(file(p.home, client, name)), true); assert.equal(fs.existsSync(file(p.home, client, name, true)), false); }
    await apply(options, 'uninstall');
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const root = skillRoot('agy', p.home);
  fs.rmdirSync(root);
  fs.symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manageSkills(p.options), /Linked skill root/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('catalog updates refresh disabled bytes without enabling them or installing newly added skills', async t => {
  const p = profile(t);
  await apply(p.options, 'install', [names[0]]);
  await apply(p.options, 'disable', [names[0]]);
  const nextCatalog = path.join(p.home, 'next-catalog');
  fs.cpSync(catalog, nextCatalog, { recursive: true });
  const updateFile = path.join(nextCatalog, names[0], 'SKILL.md');
  fs.appendFileSync(updateFile, '\nNew package revision.\n');
  const newName = 'coagent8-new';
  fs.mkdirSync(path.join(nextCatalog, newName));
  fs.writeFileSync(path.join(nextCatalog, newName, 'SKILL.md'), `---\nname: ${newName}\ndescription: New catalog package.\n---\nNew.\n`);
  const options = { ...p.options, skillsSource: nextCatalog };
  await apply(options, 'install', [names[0]]);
  assert.deepEqual(fs.readFileSync(file(p.home, 'agy', names[0], true)), fs.readFileSync(updateFile));
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0])), false);
  assert.equal(fs.existsSync(file(p.home, 'agy', newName)), false);
});

test('bundled CLI skills preview/apply changes files without starting a backend', async t => {
  const p = profile(t), executable = path.resolve(__dirname, '../../dist/index.cjs');
  const run = args => {
    const result = spawnSync(process.execPath, [executable, 'skills', ...args], { env: p.env, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const flags = ['install', '--clients=agy', `--skills=${names[0]}`];
  const preview = run(flags);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0])), false);
  const applied = run([...flags, `--apply=${preview[0].token}`]);
  assert.equal(applied[0].applied, true);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0])), true);
  assert.equal(run(['status', '--clients=agy'])[0].skills.find(item => item.name === names[0]).state, 'enabled');
  const disable = run(['disable', '--clients=agy']);
  run(['disable', '--clients=agy', `--apply=${disable[0].token}`]);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0], true)), true);
});

test('catalog removal reconciles owned packages and selections without blocking remaining actions', async t => {
  const p = profile(t);
  await apply(p.options, 'install', [names[0], names[1]]);
  await apply(p.options, 'disable', [names[0]]);
  const reduced = path.join(p.home, 'reduced-catalog');
  fs.mkdirSync(reduced);
  fs.cpSync(path.join(catalog, names[1]), path.join(reduced, names[1]), { recursive: true });
  const options = { ...p.options, skillsSource: reduced };
  const status = await manageSkills(options);
  assert.deepEqual(status.selection, { installed: [names[1]], disabled: [] });
  await apply(options, 'disable', [names[1]]);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[0], true)), false);
  assert.equal(fs.existsSync(file(p.home, 'agy', names[1], true)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.env.coagent8_CONFIG)).backends.agy.skills, { installed: [names[1]], disabled: [names[1]] });
});

test('configuration apply refuses a changed snapshot and committed recovery retains new files', async t => {
  const p = profile(t);
  await apply(p.options, 'install', [names[0]]);
  const configBefore = fs.readFileSync(p.env.coagent8_CONFIG, 'utf8');
  fs.appendFileSync(p.env.coagent8_CONFIG, '\n');
  await assert.rejects(setBackendSkills('agy', { installed: [], disabled: [] }, p.env.coagent8_CONFIG, configBefore), /changed concurrently/);
  assert.equal(fs.readFileSync(p.env.coagent8_CONFIG, 'utf8'), configBefore + '\n');
  const stateAfter = fs.readFileSync(p.state, 'utf8');
  const content = fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8');
  const journal = path.join(p.home, '.coagent8/skill-transaction.json');
  fs.writeFileSync(journal, JSON.stringify({ client: 'agy', stateBefore: null, stateAfter, committed: true, packages: [{ name: names[0], disabled: false, before: null, after: content }] }));
  recoverSkillTransaction(p.home);
  assert.equal(fs.readFileSync(file(p.home, 'agy', names[0]), 'utf8'), content);
  assert.equal(fs.existsSync(journal), false);
  assert.throws(() => transactSkills(p.home, 'agy', [{ name: names[0], disabled: false, content: 'x'.repeat(65537) }], stateAfter, () => stateAfter), /Invalid skill transaction package/);
  assert.equal(fs.existsSync(journal), false);
});

test('a redirected ownership directory is rejected before any setup or cleanup lease writes', async t => {
  const p = profile(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-ownership-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(p.home, '.coagent8'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manageSkills({ ...p.options, selection: { installed: [], disabled: [] }, apply: 'invalid' }), /Linked skill root/);
  await assert.rejects(setupClients({ home: p.home, env: p.env, clients: ['agy'], runtimeSource: path.resolve(__dirname, '../../dist/index.cjs'), skillsSource: catalog }), /Linked skill root/);
  await assert.rejects(cleanupClients({ home: p.home, env: p.env, apply: 'invalid' }), /Linked skill root/);
  assert.deepEqual(fs.readdirSync(outside), [], 'no lease, journal, state or runtime is written through the junction');
});
