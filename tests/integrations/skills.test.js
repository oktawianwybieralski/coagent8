const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  readSkillCatalog,
  installSkills,
  previewSkillRemoval,
  removeSkills,
  skillRoot,
  describeSkills,
} = require('../../src/integrations/skills.ts');
const { setupClients } = require('../../src/integrations/setup.ts');
const { cleanupClients } = require('../../src/integrations/cleanup.ts');
const catalogDir = path.resolve(__dirname, '../../skills');
const fixture = path.resolve(__dirname, '../fixtures/setup-cli/client.cjs');
const digest = text => createHash('sha256').update(text).digest('hex');
function temp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function skill(name, body = 'Use CoAgent8.') {
  return `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}\n`;
}
function catalogOf(t, packages) {
  const dir = temp(t, 'coagent8-catalog-');
  for (const [name, content] of Object.entries(packages)) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), content);
  }
  return dir;
}
function profile(t) {
  const home = temp(t, 'coagent8-skills-');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_CONFIG_PATH: undefined,
    GEMINI_CLI_HOME: undefined,
    coagent8_DIR: path.join(home, '.coagent8'),
    SETUP_FIXTURE_HOME: home,
  };
  return { home, env, state: path.join(home, '.coagent8/setup.json') };
}

test('the packaged catalog names one SKILL.md per CoAgent8 function', () => {
  const catalog = readSkillCatalog(catalogDir);
  assert.deepEqual(
    catalog.map(item => item.name),
    ['coagent8-consult', 'coagent8-delegate', 'coagent8-doctor', 'coagent8-issue', 'coagent8-loop', 'coagent8-review', 'coagent8-session'],
  );
  for (const item of catalog) {
    assert.match(item.content, new RegExp(`^---\\r?\\nname: ${item.name}\\r?\\ndescription: \\S`));
    assert.equal(item.digest, digest(item.content));
  }
});

test('an invalid catalog is refused as a package defect', t => {
  assert.throws(() => readSkillCatalog(catalogOf(t, {})), /empty/);
  assert.throws(() => readSkillCatalog(catalogOf(t, { 'other-skill': skill('other-skill') })), /not a CoAgent8 skill/);
  assert.throws(() => readSkillCatalog(catalogOf(t, { 'coagent8-a': skill('coagent8-b') })), /frontmatter/);
  const extra = catalogOf(t, { 'coagent8-a': skill('coagent8-a') });
  fs.writeFileSync(path.join(extra, 'coagent8-a', 'run.sh'), 'echo never');
  assert.throws(() => readSkillCatalog(extra), /only SKILL\.md/);
});

test('install, update, preserve and drop follow the recorded digests', t => {
  const home = temp(t, 'coagent8-skills-home-');
  const root = skillRoot('claude', home);
  const v1 = readSkillCatalog(
    catalogOf(t, { 'coagent8-a': skill('coagent8-a'), 'coagent8-b': skill('coagent8-b'), 'coagent8-c': skill('coagent8-c') }),
  );
  // Another tool's skill and a same-named user directory with extra files are not setup's.
  fs.mkdirSync(path.join(root, 'third-party'), { recursive: true });
  fs.writeFileSync(path.join(root, 'third-party', 'SKILL.md'), 'keep');
  fs.mkdirSync(path.join(root, 'coagent8-c'));
  fs.writeFileSync(path.join(root, 'coagent8-c', 'SKILL.md'), 'user');
  fs.writeFileSync(path.join(root, 'coagent8-c', 'notes.md'), 'user');
  const first = installSkills('claude', home, v1, {});
  assert.deepEqual(
    first.statuses.map(s => [s.name, s.action]),
    [
      ['coagent8-a', 'installed'],
      ['coagent8-b', 'installed'],
      ['coagent8-c', 'preserved'],
    ],
  );
  assert.deepEqual(Object.keys(first.owned), ['coagent8-a', 'coagent8-b']);
  assert.equal(first.written, true);
  assert.equal(fs.readFileSync(path.join(root, 'coagent8-a', 'SKILL.md'), 'utf8'), v1[0].content);
  assert.equal(fs.readFileSync(path.join(root, 'third-party', 'SKILL.md'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(path.join(root, 'coagent8-a')), ['SKILL.md'], 'no temporary file is left');

  const again = installSkills('claude', home, v1, first.owned);
  assert.ok(again.statuses.slice(0, 2).every(s => s.action === 'current'));
  assert.equal(again.written, false);

  // The user edits b; the next version changes a and drops b.
  fs.writeFileSync(path.join(root, 'coagent8-b', 'SKILL.md'), 'edited by the user');
  const v2 = readSkillCatalog(catalogOf(t, { 'coagent8-a': skill('coagent8-a', 'Version 2.') }));
  const update = installSkills('claude', home, v2, first.owned);
  assert.deepEqual(
    update.statuses.map(s => [s.name, s.action]),
    [
      ['coagent8-a', 'updated'],
      ['coagent8-b', 'preserved'],
    ],
  );
  assert.deepEqual(update.owned, { 'coagent8-a': v2[0].digest });
  assert.equal(fs.readFileSync(path.join(root, 'coagent8-a', 'SKILL.md'), 'utf8'), v2[0].content);
  assert.equal(fs.readFileSync(path.join(root, 'coagent8-b', 'SKILL.md'), 'utf8'), 'edited by the user');

  // Dropped and unchanged: removed with its directory.
  const v3 = readSkillCatalog(catalogOf(t, { 'coagent8-z': skill('coagent8-z') }));
  const dropped = installSkills('claude', home, v3, update.owned);
  assert.deepEqual(
    dropped.statuses.map(s => [s.name, s.action]),
    [
      ['coagent8-z', 'installed'],
      ['coagent8-a', 'removed'],
    ],
  );
  assert.equal(fs.existsSync(path.join(root, 'coagent8-a')), false);
  assert.match(describeSkills('codex', dropped.statuses), /1 installed, 1 removed; mention one as \$coagent8-review/);
});

test('a link or file in place of a package directory is never followed or replaced', t => {
  const home = temp(t, 'coagent8-skills-link-'),
    outside = temp(t, 'coagent8-skills-outside-');
  const root = skillRoot('codex', home);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'outside');
  try {
    fs.symlinkSync(outside, path.join(root, 'coagent8-a'), 'junction');
  } catch (error) {
    t.skip(`links unavailable: ${error.code}`);
    return;
  }
  fs.writeFileSync(path.join(root, 'coagent8-b'), 'a file');
  const catalog = readSkillCatalog(catalogOf(t, { 'coagent8-a': skill('coagent8-a'), 'coagent8-b': skill('coagent8-b') }));
  const result = installSkills('codex', home, catalog, { 'coagent8-a': digest('outside') });
  assert.deepEqual(
    result.statuses.map(s => s.action),
    ['preserved', 'preserved'],
  );
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'outside');
  assert.deepEqual(
    previewSkillRemoval('codex', home, { 'coagent8-a': digest('outside') }).map(s => s.action),
    ['preserved'],
  );
});

test('removal deletes only unchanged recorded packages and re-checks after the preview', t => {
  const home = temp(t, 'coagent8-skills-remove-');
  const root = skillRoot('agy', home);
  const catalog = readSkillCatalog(
    catalogOf(t, { 'coagent8-a': skill('coagent8-a'), 'coagent8-b': skill('coagent8-b'), 'coagent8-c': skill('coagent8-c') }),
  );
  const { owned } = installSkills('agy', home, catalog, {});
  fs.writeFileSync(path.join(root, 'coagent8-b', 'SKILL.md'), 'edited');
  fs.rmSync(path.join(root, 'coagent8-c'), { recursive: true });
  const preview = previewSkillRemoval('agy', home, owned);
  assert.deepEqual(
    preview.map(s => [s.name, s.action]),
    [
      ['coagent8-a', 'remove'],
      ['coagent8-b', 'preserved'],
      ['coagent8-c', 'absent'],
    ],
  );
  assert.ok(fs.existsSync(path.join(root, 'coagent8-a', 'SKILL.md')), 'preview is read-only');
  const applied = removeSkills('agy', home, owned, preview);
  assert.deepEqual(
    applied.statuses.map(s => s.action),
    ['removed', 'preserved', 'absent'],
  );
  assert.deepEqual(applied.owned, {});
  assert.equal(fs.existsSync(path.join(root, 'coagent8-a')), false);
  assert.equal(fs.readFileSync(path.join(root, 'coagent8-b', 'SKILL.md'), 'utf8'), 'edited');
  // An edit between preview and apply wins over the preview.
  const again = installSkills('agy', home, catalog.slice(0, 1), {});
  const late = previewSkillRemoval('agy', home, again.owned);
  fs.writeFileSync(path.join(root, 'coagent8-a', 'SKILL.md'), 'edited late');
  assert.equal(removeSkills('agy', home, again.owned, late).statuses[0].action, 'preserved');
  assert.equal(fs.readFileSync(path.join(root, 'coagent8-a', 'SKILL.md'), 'utf8'), 'edited late');
});

test('setup installs the catalog with each registration and cleanup removes both; origins are respected', async t => {
  const p = profile(t);
  const env = { ...p.env, CODEX_PATH: fixture, CLAUDE_PATH: fixture, AGY_PATH: fixture };
  const runtimeSource = path.resolve(__dirname, '../../dist/index.cjs');
  const installed = await setupClients({
    ...p,
    env,
    cwd: p.home,
    runtimeSource,
    skillsSource: catalogDir,
    clients: ['codex', 'claude'],
    origin: 'vscode-extension',
  });
  assert.ok(
    installed.every(result => result.action === 'installed' && result.skills.every(skill => skill.action === 'installed')),
    JSON.stringify(installed),
  );
  assert.match(installed.find(result => result.client === 'claude').message, /Skills: 7 installed; type \/coagent8-review/);
  const cli = await setupClients({ ...p, env, cwd: p.home, runtimeSource, skillsSource: catalogDir, clients: ['agy'] });
  assert.equal(cli[0].skills.length, 7);
  for (const client of ['codex', 'claude', 'agy']) assert.equal(fs.readdirSync(skillRoot(client, p.home)).length, 7, client);
  const state = JSON.parse(fs.readFileSync(p.state, 'utf8'));
  assert.deepEqual(Object.keys(state.skills).sort(), ['agy', 'claude', 'codex']);
  assert.deepEqual(state.skillOrigin, { codex: 'vscode-extension', claude: 'vscode-extension' });

  // A repeated setup leaves current packages alone.
  const repeated = await setupClients({
    ...p,
    env,
    cwd: p.home,
    runtimeSource,
    skillsSource: catalogDir,
    clients: ['claude'],
    origin: 'vscode-extension',
  });
  assert.ok(
    repeated[0].skills.every(skill => skill.action === 'current'),
    JSON.stringify(repeated),
  );

  // The VS Code uninstall removes what the extension wrote and keeps the CLI's packages.
  const options = {
    home: p.home,
    env: { ...p.env, CODEX_PATH: 'absent', CLAUDE_PATH: 'absent', AGY_PATH: 'absent' },
    origin: 'vscode-extension',
    uninstall: true,
  };
  const preview = await cleanupClients(options);
  assert.ok(preview.results.find(result => result.client === 'agy').skills.every(skill => skill.action === 'preserved'));
  assert.ok(fs.existsSync(path.join(skillRoot('claude', p.home), 'coagent8-review')), 'preview is read-only');
  const applied = await cleanupClients({ ...options, apply: preview.token });
  for (const client of ['codex', 'claude']) {
    const result = applied.results.find(item => item.client === client);
    assert.equal(result.action, 'removed');
    assert.ok(
      result.skills.every(skill => skill.action === 'removed'),
      JSON.stringify(result),
    );
    assert.deepEqual(fs.readdirSync(skillRoot(client, p.home)), []);
  }
  assert.equal(fs.readdirSync(skillRoot('agy', p.home)).length, 7);

  // The CLI cleanup (before npm uninstall) removes the rest and the empty setup state.
  const cliOptions = { home: p.home, env: options.env, uninstall: true };
  const rest = await cleanupClients({ ...cliOptions, apply: (await cleanupClients(cliOptions)).token });
  assert.ok(
    rest.results.find(result => result.client === 'agy').skills.every(skill => skill.action === 'removed'),
    JSON.stringify(rest),
  );
  assert.deepEqual(fs.readdirSync(skillRoot('agy', p.home)), []);
  assert.equal(fs.existsSync(p.state), false);
});

test('setup with an invalid catalog changes no client', async t => {
  const p = profile(t);
  const env = { ...p.env, CLAUDE_PATH: fixture };
  const broken = catalogOf(t, { 'coagent8-a': skill('coagent8-other') });
  await assert.rejects(
    setupClients({
      ...p,
      env,
      cwd: p.home,
      runtimeSource: path.resolve(__dirname, '../../dist/index.cjs'),
      skillsSource: broken,
      clients: ['claude'],
    }),
    /frontmatter/,
  );
  assert.equal(fs.existsSync(path.join(p.home, '.claude.json')), false);
  assert.equal(fs.existsSync(skillRoot('claude', p.home)), false);
});
