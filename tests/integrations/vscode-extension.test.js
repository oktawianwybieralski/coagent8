const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');

/** A configuration change event with VS Code's semantics: a section matches itself and its parents. */
function affects(...changed) {
  return { affectsConfiguration(section) { return changed.some(key => key === section || key.startsWith(section + '.')); } };
}

async function runSetupPicker({ installed = ['codex', 'claude', 'agy'], selected = ['agy'], action, remembered, command = 'coagent8.setup', failInstall = false, blocked = [], vendorExtensions = [], discoverable = [], dismissed = true, activationOnly = false, configPath = '', savedMcp = false, settingsChanged = false, dirtyFiles = [], legacyState = {}, awaitState = false, announced = false, awaitNotifications = 0 } = {}) {
  const handlers = {}, registrations = [], requests = [], errors = [], terminals = [], reports = [], progress = [], warnings = [], events = [], reveals = [];
  // Each prompt answers with the first scripted action it offers. A CLI in
  // `discoverable` becomes installed once the extension resolves it after an installation.
  const answer = offered => [].concat(action ?? []).find(choice => offered.includes(choice));
  const cleanupCalls = [];
  const notifications = [], legacyUpdates = [], openedFiles = [];
  const legacy = new Map(Object.entries(legacyState));
  let savedListener, configurationListener;
  let definitionChanges = 0;
  const dispose = () => {};
  const vscode = {
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    Uri: { file(file) { return { fsPath: file, toString() { return require('node:url').pathToFileURL(file).href; } }; } },
    env: {},
    extensions: { getExtension(id) { return vendorExtensions.includes(id) ? { extensionPath: path.resolve('vendor', id), extensionUri: { scheme: 'file' } } : undefined; }, onDidChange() { return { dispose }; } },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { event = () => {}; fire() { definitionChanges++; } dispose() {} },
    workspace: {
      async openTextDocument(uri) { return { uri, text: fs.readFileSync(uri.fsPath, 'utf8') }; },
      onDidChangeConfiguration(listener) { configurationListener = listener; return { dispose }; },
      createFileSystemWatcher() { return { dispose, onDidChange(listener) { savedListener = listener; return { dispose }; }, onDidCreate() { return { dispose }; }, onDidDelete() { return { dispose }; } }; },
      getConfiguration() { return { get(key, fallback) { return key === 'nodePath' ? 'node' : key === 'configPath' ? configPath : fallback; }, inspect() { return {}; } }; }, workspaceFolders: [],
      textDocuments: dirtyFiles.map(file => ({ uri: { scheme: 'file', fsPath: file }, isDirty: true })),
    },
    lm: { registerMcpServerDefinitionProvider() { return { dispose }; } },
    commands: {
      registerCommand(name, handler) { handlers[name] = handler; return { dispose }; },
      async executeCommand(...args) { requests.push(args); if (failInstall) throw new Error('fixture installation cancelled'); },
    },
    window: {
      async showQuickPick(items, options) {
        assert.equal(options.ignoreFocusOut, true);
        return selected === null ? undefined : items.filter(item => selected.includes(item.client));
      },
      // The setup picker opens before the CLI checks and is answered once it is enabled.
      createQuickPick() {
        const listeners = {};
        let enabled = true;
        return {
          items: [], selectedItems: [], busy: false, ignoreFocusOut: false, canSelectMany: false, dispose,
          show() { events.push('show'); assert.equal(this.busy, true); assert.equal(enabled, false); },
          onDidAccept(listener) { listeners.accept = listener; return { dispose }; },
          onDidHide(listener) { listeners.hide = listener; return { dispose }; },
          get enabled() { return enabled; },
          set enabled(value) {
            enabled = value;
            if (!value) return;
            setImmediate(() => {
              assert.equal(this.ignoreFocusOut, true); assert.equal(this.canSelectMany, true); assert.equal(this.busy, false);
              assert.deepEqual(Array.from(this.items, item => item.label), ['Codex CLI', 'Claude Code CLI', 'Antigravity CLI']);
              for (const item of this.items) {
                const pending = item.client === 'agy' && vendorExtensions.includes('google.google-antigravity');
                assert.match(item.description, blocked.includes(item.client) ? /^Blocked/ : installed.includes(item.client) ? /^Available/ : pending ? /^Downloading/ : /^Missing/);
              }
              // Without a remembered choice, the CLIs that are already ready are selected.
              assert.deepEqual(Array.from(this.selectedItems, item => item.client), ['codex', 'claude', 'agy'].filter(client => (remembered ?? installed).includes(client)));
              if (selected === null) { listeners.hide(); return; }
              this.selectedItems = this.items.filter(item => selected.includes(item.client));
              listeners.accept();
            });
          },
        };
      },
      async showInformationMessage(message, ...actions) { notifications.push({ message, actions }); return answer(actions); },
      async showTextDocument(document) { openedFiles.push(document); },
      async showWarningMessage(message, ...rest) { warnings.push(message); return answer(rest.filter(item => typeof item === 'string')); },
      // The user cancels a wait that does not succeed on its first check.
      async withProgress(options, task) {
        progress.push(options.title);
        let cancelled = false;
        return task({ report() {} }, { get isCancellationRequested() { return cancelled; }, onCancellationRequested(listener) { setImmediate(() => { cancelled = true; listener(); }); return { dispose }; } });
      },
      createTerminal(options) {
        const terminal = { options, dispose, show() {}, sendText(command, execute) { Object.assign(this, { command, execute }); } };
        terminals.push(terminal); return terminal;
      },
      createOutputChannel() { return { dispose, appendLine(line) { reports.push(line); }, show(preserveFocus) { reveals.push(preserveFocus); } }; },
      async showErrorMessage(message) { errors.push(message); },
    },
  };
  const output = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../..', 'extensions/vscode/src/extension.ts')],
    bundle: true, write: false, platform: 'node', target: 'node24', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
    plugins: [{ name: 'isolated-setup', setup(build) {
      build.onLoad({ filter: /[\\/]integrations[\\/]cleanup\.ts$/ }, () => ({
        contents: "export async function cleanupClients(options) { globalThis.recordCleanup(options.apply); return { token: 'fixture-preview', results: [{client:'claude',action:options.apply?'removed':'remove',message:'fixture'}] }; }", loader: 'js',
      }));
      build.onLoad({ filter: /[\\/]integrations[\\/]setup\.ts$/ }, () => ({
        contents: "export const SETUP_CLIENTS = ['codex', 'claude', 'agy']; const appeared = new Set(); export function resolveSetupClient(client) { if (!globalThis.discoverable.includes(client)) return null; appeared.add(client); return { command: 'fixture-' + client, argsPrefix: [], source: 'native' }; } export async function setupClients(options) { globalThis.recordEvent('status'); if (options.origin !== 'vscode-extension') throw new Error('missing extension origin'); if (!options.statusOnly) { globalThis.recordClients(options.clients); return globalThis.statuses.map(status => ({ ...status, action: 'installed' })); } return globalThis.statuses.map(status => !status.installed && appeared.has(status.client) ? { ...status, installed: true, compatibility: 'supported', authentication: 'unknown', ready: false } : status); }", loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  const statuses = ['codex', 'claude', 'agy'].map(client => ({ client, installed: installed.includes(client), compatibility: installed.includes(client) ? 'supported' : 'unknown', authentication: 'authenticated', ready: installed.includes(client), registered: false, action: blocked.includes(client) ? 'blocked' : 'missing', message: 'fixture' }));
  vm.runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, statuses, discoverable, setTimeout, clearTimeout, setInterval, clearInterval,
    recordClients(clients) { registrations.push(Array.from(clients)); },
    recordCleanup(apply) { cleanupCalls.push(apply); },
    recordEvent(name) { events.push(name); },
    require(name) { return name === 'vscode' ? vscode : require(name); },
  });
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-extension-'));
  // Onboarding state lives in the extension's global storage, which VS Code deletes on uninstall.
  const storage = path.join(extensionRoot, 'User/globalStorage/okidev.coagent8-mcp');
  const stateFile = path.join(storage, 'setup-state.json');
  const seeded = { ...(remembered === undefined ? {} : { setupClients: remembered }), ...(dismissed ? { setupDismissed: true } : {}), ...(announced ? { readyAnnounced: true } : {}) };
  if (Object.keys(seeded).length) { fs.mkdirSync(storage, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(seeded)); }
  const readState = () => fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : undefined;
  const initialState = readState();
  fs.mkdirSync(path.join(extensionRoot, 'dist'));
  fs.writeFileSync(path.join(extensionRoot, 'dist/index.cjs'), 'fixture runtime');
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: storage },
    globalState: { get(key) { return legacy.get(key); }, async update(key, value) { legacyUpdates.push({ key, value }); if (value === undefined) legacy.delete(key); else legacy.set(key, value); } },
    asAbsolutePath(relative) { return path.join(extensionRoot, relative); },
  };
  try {
    module.exports.activate(context);
    if (!activationOnly) await handlers[command]();
    if (settingsChanged) configurationListener(affects('coagent8.configPath'));
    if (savedMcp) {
      const mcp = path.join(extensionRoot, 'User/mcp.json');
      fs.mkdirSync(path.dirname(mcp), { recursive: true });
      fs.writeFileSync(mcp, JSON.stringify({ servers: { coagent8: { command: 'fixture' } } }));
      savedListener();
    }
    await new Promise(resolve => setImmediate(resolve));
    // The welcome runs after activation; its locked state write completes asynchronously.
    for (const deadline = Date.now() + 2000; (awaitState && readState() === initialState) || notifications.length < awaitNotifications;) {
      assert.ok(Date.now() < deadline, 'the onboarding state or notification did not arrive');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const finalState = readState();
    const state = finalState === undefined ? undefined : JSON.parse(finalState);
    const stateChanged = finalState !== initialState;
    const selections = stateChanged && state?.setupClients ? Array.from(state.setupClients) : undefined;
    const storageFiles = fs.existsSync(storage) ? fs.readdirSync(storage) : [];
    return { selections, registrations, terminals, requests, errors, reports, cleanupCalls, progress, warnings, events, reveals, notifications, state, stateChanged, legacyUpdates, legacy, openedFiles, definitionChanges, storageFiles };
  } finally { fs.rmSync(extensionRoot, { recursive: true, force: true }); }
}

test('welcome persists across legacy setupOffered profiles until ready or explicitly dismissed', async () => {
  const first = await runSetupPicker({ installed: [], dismissed: false, activationOnly: true });
  assert.equal(first.notifications.length, 1);
  assert.deepEqual(first.notifications[0].actions, ['Set Up CLIs', "Don't Show Again"]);
  assert.equal(first.stateChanged, false);
  assert.equal((await runSetupPicker({ installed: [], dismissed: false, activationOnly: true })).notifications.length, 1);
  const dismissed = await runSetupPicker({ installed: [], dismissed: false, activationOnly: true, action: "Don't Show Again", awaitState: true });
  assert.deepEqual(dismissed.state, { setupDismissed: true });
  const suppressed = await runSetupPicker({ installed: [], dismissed: true, activationOnly: true });
  assert.equal(suppressed.notifications.length, 0);
  assert.equal(suppressed.events.length, 0, 'explicit dismissal avoids startup probes');
  const ready = await runSetupPicker({ installed: ['codex'], dismissed: false, activationOnly: true, awaitState: true, awaitNotifications: 1 });
  assert.equal(ready.notifications.length, 1, 'ready CLIs are announced once instead of the welcome');
  assert.match(ready.notifications[0].message, /^CoAgent8 is ready with Codex CLI. /);
  assert.deepEqual(ready.notifications[0].actions, ['Show MCP Servers']);
  assert.deepEqual(ready.state, { readyAnnounced: true });
  const again = await runSetupPicker({ installed: ['codex'], dismissed: false, activationOnly: true, announced: true });
  assert.equal(again.notifications.length, 0, 'the ready notice is shown once');
  assert.equal(ready.terminals.length, 0);
  assert.equal(ready.reveals.length, 0);
});

test('onboarding state from earlier builds is removed from globalState, which VS Code keeps after uninstall', async () => {
  const result = await runSetupPicker({ installed: [], dismissed: false, activationOnly: true, legacyState: { setupClients: ['codex'], setupOffered: true, setupDismissed: true, unrelated: 'kept' } });
  assert.deepEqual(result.legacyUpdates, ['setupClients', 'setupOffered', 'setupDismissed'].map(key => ({ key, value: undefined })));
  assert.deepEqual([...result.legacy], [['unrelated', 'kept']]);
  assert.equal(result.notifications.length, 1, 'a legacy dismissal does not suppress the first-install welcome');
  assert.deepEqual((await runSetupPicker({ installed: [], dismissed: false, activationOnly: true })).legacyUpdates, [], 'nothing to remove');
});

test('setup reset clears only remembered choices and dismissal, rechecks readiness, and cancellation preserves state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-setup-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const bytes = '{ "schemaVersion": 1, "defaultBackend": "codex" }\n';
  fs.writeFileSync(file, bytes);
  const options = { command: 'coagent8.resetSetupState', remembered: ['codex'], installed: [], configPath: file };
  const cancelled = await runSetupPicker(options);
  assert.equal(cancelled.stateChanged, false);
  assert.deepEqual(cancelled.state, { setupClients: ['codex'], setupDismissed: true });
  const reset = await runSetupPicker({ ...options, action: 'Reset Setup State' });
  assert.equal(reset.state, undefined, 'every remembered choice is removed');
  assert.deepEqual(reset.storageFiles, [], 'no lock or temporary file remains');
  assert.ok(reset.notifications.some(item => item.actions.includes("Don't Show Again")), 'reset offers welcome again when no CLI is ready');
  assert.deepEqual(reset.registrations, []);
  assert.deepEqual(reset.cleanupCalls, []);
  assert.deepEqual(reset.requests, [], 'no editor restart');
  assert.equal(reset.terminals.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const ready = await runSetupPicker({ ...options, installed: ['codex'], action: 'Reset Setup State' });
  assert.equal(ready.notifications.some(item => item.actions.includes("Don't Show Again")), false, 'a ready CLI suppresses welcome after reset');
});

test('Open Configuration creates defaults only when absent and opens malformed existing JSON unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-editor-'));
  const file = path.join(directory, 'custom', 'config.json');
  const previous = process.env.coagent8_CONFIG;
  process.env.coagent8_CONFIG = file;
  try {
    const created = await runSetupPicker({ command: 'coagent8.openConfiguration' });
    assert.equal(created.errors.length, 0);
    assert.equal(created.openedFiles[0].uri.fsPath, file);
    const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(defaults.$schema, /schemas\/config.schema.json$/);
    delete defaults.$schema;
    assert.deepEqual(defaults, require('../../src/config.ts').validateConfig({}));
    fs.writeFileSync(file, '{ malformed existing configuration');
    const existing = await runSetupPicker({ command: 'coagent8.openConfiguration' });
    assert.equal(existing.openedFiles[0].text, '{ malformed existing configuration');
    assert.equal(fs.readFileSync(file, 'utf8'), existing.openedFiles[0].text);
  } finally {
    if (previous === undefined) delete process.env.coagent8_CONFIG; else process.env.coagent8_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Reset Configuration needs confirmation, keeps one backup and refuses unsaved edits', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-reset-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const first = '{ "schemaVersion": 1, "defaultBackend": "codex" }\n';
  fs.writeFileSync(file, first);
  const options = { command: 'coagent8.resetConfiguration', configPath: file };
  const cancelled = await runSetupPicker(options);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(fs.existsSync(file + '.backup'), false);
  assert.match(cancelled.warnings[0], /config\.json\.backup, replacing an earlier backup/);
  const dirty = await runSetupPicker({ ...options, action: 'Reset Configuration', dirtyFiles: [file] });
  assert.match(dirty.errors[0], /Save or revert/);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  const reset = await runSetupPicker({ ...options, action: ['Reset Configuration', 'Open Settings'] });
  assert.deepEqual(reset.errors, []);
  assert.equal(fs.readFileSync(file + '.backup', 'utf8'), first);
  const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(defaults.$schema, /schemas\/config\.schema\.json$/);
  delete defaults.$schema;
  assert.deepEqual(defaults, require('../../src/config.ts').validateConfig({}));
  assert.equal(reset.openedFiles[0].uri.fsPath, file);
  assert.deepEqual(reset.requests, [['coagent8.openSettings']]);
  const second = fs.readFileSync(file, 'utf8');
  await runSetupPicker({ ...options, action: 'Reset Configuration' });
  assert.equal(fs.readFileSync(file + '.backup', 'utf8'), second, 'the next reset replaces the single backup');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['config.json', 'config.json.backup'], 'no lock, temporary or extra backup files remain');
});

test('settings and MCP server commands open the native VS Code views', async () => {
  assert.deepEqual((await runSetupPicker({ command: 'coagent8.openSettings' })).requests, [['workbench.action.openSettings', '@ext:okidev.coagent8-mcp']]);
  assert.deepEqual((await runSetupPicker({ command: 'coagent8.manageMcpServers' })).requests, [['workbench.mcp.listServer']]);
});

test('every registered command is contributed with a title and every contributed command is registered', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../extensions/vscode/src/extension.ts'), 'utf8');
  const registered = [...source.matchAll(/register\('(coagent8\.[A-Za-z]+)'/g)].map(match => match[1]).sort();
  const contributed = require('../../extensions/vscode/package.json').contributes.commands;
  assert.deepEqual(contributed.map(item => item.command).sort(), registered);
  assert.ok(contributed.every(item => /^CoAgent8: /.test(item.title)));
});

test('the user configPath setting overrides the environment for editing and rejects relative paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-setting-'));
  const file = path.join(directory, 'custom configuration.json');
  const previous = process.env.coagent8_CONFIG;
  process.env.coagent8_CONFIG = path.join(directory, 'environment configuration.json');
  try {
    const result = await runSetupPicker({ command: 'coagent8.openConfiguration', configPath: file });
    assert.equal(result.errors.length, 0);
    assert.equal(result.openedFiles[0].uri.fsPath, file);
    assert.equal(fs.existsSync(process.env.coagent8_CONFIG), false, 'the environment override must not be created instead');
    fs.writeFileSync(file, '{ malformed preserved');
    const existing = await runSetupPicker({ command: 'coagent8.openConfiguration', configPath: file });
    assert.equal(existing.openedFiles[0].text, '{ malformed preserved');
    const invalid = await runSetupPicker({ command: 'coagent8.openConfiguration', configPath: 'relative/config.json' });
    assert.match(invalid.errors[0], /absolute path/);
  } finally {
    if (previous === undefined) delete process.env.coagent8_CONFIG; else process.env.coagent8_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('settings and filesystem MCP changes invalidate provider definitions without restarting the window or other extensions', async () => {
  const settings = await runSetupPicker({ activationOnly: true, settingsChanged: true });
  assert.equal(settings.definitionChanges, 1);
  assert.deepEqual(settings.requests, []);
  const saved = await runSetupPicker({ activationOnly: true, savedMcp: true });
  assert.equal(saved.definitionChanges, 1, 'filesystem writes from the MCP UI also invalidate the provider');
  assert.deepEqual(saved.requests, []);
  assert.equal(saved.terminals.length, 0);
});

test('CLI selection remembers full-label backend choices without authorizing external registration', async () => {
  const result = await runSetupPicker();
  assert.deepEqual(result.selections, ['agy']);
  assert.deepEqual(result.registrations, []);
});
test('the setup picker opens before CLI checks and the setup channel never takes focus', async () => {
  const result = await runSetupPicker({ installed: [], selected: ['claude'], remembered: ['claude'], action: 'Install Standalone CLI' });
  assert.deepEqual(result.events.slice(0, 2), ['show', 'status'], 'feedback appears before the bounded checks finish');
  assert.ok(result.reveals.every(preserveFocus => preserveFocus === true), 'revealing setup output must not dismiss the picker');
  const shown = await runSetupPicker({ command: 'coagent8.refreshCliStatus', action: 'Show Details' });
  assert.deepEqual(shown.reveals, [true]);
});
test('setup without changes checks once and logs one readable line; details only on request', async () => {
  const quiet = await runSetupPicker({ selected: ['codex', 'claude', 'agy'] });
  assert.equal(quiet.events.filter(event => event === 'status').length, 1, 'no second identical check');
  assert.equal(quiet.reports.length, 1);
  assert.match(quiet.reports[0], /^\[\d\d:\d\d:\d\d\] Set Up Coding CLIs - codex: ready; claude: ready; agy: ready$/);
  const detailed = await runSetupPicker({ selected: ['codex'], action: 'Show Details' });
  assert.equal(detailed.reports.length, 2);
  assert.equal(JSON.parse(detailed.reports[1]).length, 3, 'full evidence follows the summary line');
});
test('the summary offers native-host registration for ready CLIs without writing it', async () => {
  const result = await runSetupPicker({ command: 'coagent8.refreshCliStatus', action: 'Register in Chat Hosts' });
  assert.deepEqual(result.requests, [['coagent8.registerNativeHosts']], 'the registration command keeps its own selection and confirmation');
  assert.deepEqual(result.registrations, []);
});
test('missing Antigravity offers official installer without running it or registering a host', async () => {
  const result = await runSetupPicker({ installed: ['claude'], selected: ['agy'], action: 'Install Standalone CLI' });
  assert.deepEqual(result.registrations, []);
  assert.equal(result.terminals.length, 1);
  assert.match(result.terminals[0].command, /https:\/\/antigravity\.google\/cli\/install\.(ps1|sh)/);
  assert.equal(result.terminals[0].execute, false);
  assert.equal(result.terminals[0].options.shellPath, process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
});
test('vendor extension installation is explicit; cancellation/failure and override errors remain retryable', async () => {
  const installed = await runSetupPicker({ installed: [], selected: ['codex'], action: 'Install Vendor Extension' });
  assert.deepEqual(installed.requests, [['workbench.extensions.installExtension', 'openai.chatgpt']]);
  assert.deepEqual(installed.registrations, []);
  const failed = await runSetupPicker({ installed: [], selected: ['codex', 'claude'], action: 'Install Vendor Extension', failInstall: true });
  assert.equal(failed.errors.length, 2);
  assert.equal(failed.requests.length, 2, 'one failure must not suppress another backend action');
  const overridden = await runSetupPicker({ installed: ['claude'], blocked: ['codex'], selected: ['codex', 'agy'], action: 'Install Standalone CLI' });
  assert.equal(overridden.terminals.length, 1);
  assert.match(overridden.terminals[0].options.name, /Antigravity/);
});
test('an installed Google Antigravity extension is awaited instead of installing agy again', async () => {
  const ready = await runSetupPicker({ installed: [], selected: ['agy'], vendorExtensions: ['google.google-antigravity'], discoverable: ['agy'], action: 'Open Sign-in Command' });
  assert.deepEqual(ready.requests, [], 'no extension or standalone installation is offered');
  assert.match(ready.progress[0], /Google Antigravity extension to download Antigravity CLI/);
  assert.equal(ready.terminals.length, 1, 'only the sign-in command follows');
  assert.match(ready.terminals[0].options.name, /^Sign in to Antigravity CLI/);
  assert.equal(ready.terminals[0].execute, false);
  assert.deepEqual(ready.registrations, []);
  const pending = await runSetupPicker({ installed: [], selected: ['agy'], vendorExtensions: ['google.google-antigravity'] });
  assert.deepEqual(pending.requests, []);
  assert.equal(pending.terminals.length, 0);
  assert.match(pending.warnings.at(-1), /Open the Antigravity view once/);
});
test('missing agy offers the Google extension, then waits for its CLI before sign-in', async () => {
  const result = await runSetupPicker({ installed: [], selected: ['agy'], discoverable: ['agy'], action: ['Install Vendor Extension', 'Open Sign-in Command'] });
  assert.deepEqual(result.requests, [['workbench.extensions.installExtension', 'google.google-antigravity']]);
  assert.match(result.progress[0], /Antigravity CLI from the Google Antigravity extension/);
  assert.equal(result.terminals.length, 1);
  assert.match(result.terminals[0].options.name, /^Sign in to Antigravity CLI/);
  assert.deepEqual(result.registrations, []);
});
test('a standalone installer is checked on request and a stale PATH asks for a reload', async () => {
  const stale = await runSetupPicker({ installed: [], selected: ['claude'], action: ['Install Standalone CLI', 'Check Now'] });
  assert.equal(stale.terminals.length, 1);
  assert.match(stale.terminals[0].command, /https:\/\/claude\.ai\/install\.(ps1|sh)/);
  assert.equal(stale.terminals[0].execute, false);
  assert.match(stale.warnings.at(-1), /not found with this window's PATH/);
  assert.deepEqual(stale.requests, []);
  const reloaded = await runSetupPicker({ installed: [], selected: ['claude'], action: ['Install Standalone CLI', 'Reload Window'] });
  assert.deepEqual(reloaded.requests, [['workbench.action.reloadWindow']]);
  const found = await runSetupPicker({ installed: [], selected: ['claude'], discoverable: ['claude'], action: ['Install Standalone CLI', 'Check Now', 'Open Sign-in Command'] });
  assert.equal(found.terminals.length, 2, 'installer, then sign-in');
  assert.match(found.terminals[1].options.name, /^Sign in to Claude Code CLI/);
  assert.deepEqual(found.registrations, []);
});
test('remembered selections and picker/installer cancellation do not change registrations', async () => {
  const cancelled = await runSetupPicker({ installed: ['claude'], selected: null, remembered: ['codex', 'claude'] });
  assert.equal(cancelled.selections, undefined); assert.deepEqual(cancelled.registrations, []); assert.equal(cancelled.terminals.length, 0);
  const declined = await runSetupPicker({ installed: ['claude'], selected: ['codex', 'claude'] });
  assert.deepEqual(declined.selections, ['codex', 'claude']); assert.equal(declined.terminals.length, 0); assert.deepEqual(declined.registrations, []);
});
test('native-host configuration is written only through the separate confirmed action', async () => {
  const declined = await runSetupPicker({ command: 'coagent8.registerNativeHosts', selected: ['claude'] });
  assert.deepEqual(declined.registrations, []);
  const accepted = await runSetupPicker({ command: 'coagent8.registerNativeHosts', selected: ['claude'], action: 'Register Selected Hosts' });
  assert.deepEqual(accepted.registrations, [['claude']]);
  assert.match(accepted.notifications.at(-1).message, /Restart the affected native chat hosts/);
});
test('refresh checks all CLI statuses without opening installers or registering hosts', async () => {
  const result = await runSetupPicker({ command: 'coagent8.refreshCliStatus' });
  assert.deepEqual(result.registrations, []); assert.equal(result.terminals.length, 0); assert.equal(result.reports.length, 1);
});
test('cleanup cancellation is read-only and confirmation applies the exact preview token', async () => {
  const declined = await runSetupPicker({ command: 'coagent8.cleanup' });
  assert.deepEqual(declined.cleanupCalls, [undefined]);
  const accepted = await runSetupPicker({ command: 'coagent8.cleanup', action: 'Remove Owned Registrations' });
  assert.deepEqual(accepted.cleanupCalls, [undefined, 'fixture-preview']);
  assert.deepEqual(accepted.selections, []);
});

test('VS Code provider uses bundled server, updates configuration/build identity, and disposes registrations', t => {
  let provider, providerId, configurationListener, extensionListener, nodePath = 'node', configPath = '';
  const inspected = {};
  let extensionPath;
  let changes = 0, disposed = 0;
  const disposable = () => ({ dispose() { disposed++; } });
  const vscode = {
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    env: { remoteName: 'isolated-test' },
    extensions: {
      getExtension(id) { return id === 'openai.chatgpt' && extensionPath ? { extensionPath, extensionUri: { scheme: 'file' } } : undefined; },
      onDidChange(listener) { extensionListener = listener; return disposable(); },
    },
    commands: { registerCommand() { return disposable(); } },
    EventEmitter: class {
      event = () => disposable();
      fire() { changes++; }
      dispose() { disposed++; }
    },
    workspace: {
      onDidChangeConfiguration(listener) { configurationListener = listener; return disposable(); },
      createFileSystemWatcher() { return { ...disposable(), onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable }; },
      getConfiguration(section) {
        assert.equal(section, 'coagent8');
        return { get(key, fallback) { return key === 'configPath' ? configPath : nodePath ?? fallback; }, inspect(key) { return inspected[key]; } };
      },
    },
    lm: {
      registerMcpServerDefinitionProvider(id, implementation) {
        providerId = id; provider = implementation; return disposable();
      },
    },
    McpStdioServerDefinition: class {
      constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
    },
  };
  const output = esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../..', 'extensions/vscode/src/extension.ts')],
    bundle: true, write: false, platform: 'node', target: 'node24', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, process, Buffer, require(name) {
    return name === 'vscode' ? vscode : require(name);
  } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension path with spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/index.cjs'), 'fixture bundle');
  const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(root, 'User/globalStorage/coagent8') }, globalState: { get() { return undefined; } }, asAbsolutePath(relative) { return path.join(root, relative); } };
  module.exports.activate(context);
  assert.equal(providerId, require('../../extensions/vscode/package.json').contributes.mcpServerDefinitionProviders[0].id);
  const definition = provider.provideMcpServerDefinitions()[0];
  assert.equal(definition.label, 'CoAgent8');
  assert.equal(definition.command, 'node');
  assert.equal(definition.args.length, 1);
  assert.equal(definition.args[0], path.join(root, 'dist/index.cjs'));
  assert.ok(definition.version.startsWith(require('../../package.json').version + '#'));
  assert.deepEqual(JSON.parse(definition.env.coagent8_EXTENSION_PATHS), {});
  assert.equal(definition.env.coagent8_DIR, context.globalStorageUri.fsPath, 'runtime data lives in storage VS Code deletes on uninstall');
  assert.equal(definition.env.coagent8_CONFIG, path.resolve(process.env.coagent8_CONFIG || path.join(context.globalStorageUri.fsPath, 'config.json')));
  nodePath = ' C:\\Program Files\\nodejs\\node.exe ';
  configurationListener(affects('coagent8.nodePath'));
  assert.equal(changes, 1);
  assert.equal(provider.provideMcpServerDefinitions()[0].command, nodePath.trim());
  configurationListener({ affectsConfiguration() { return false; } });
  assert.equal(changes, 1);
  nodePath = ' ';
  assert.throws(() => provider.provideMcpServerDefinitions(), /Node.js 24\+/);
  nodePath = 'node';
  extensionPath = path.join(root, 'custom extension root', 'openai-current');
  extensionListener();
  assert.equal(changes, 2);
  assert.equal(JSON.parse(provider.provideMcpServerDefinitions()[0].env.coagent8_EXTENSION_PATHS).codex, extensionPath);
  extensionPath = undefined;
  extensionListener();
  assert.deepEqual(JSON.parse(provider.provideMcpServerDefinitions()[0].env.coagent8_EXTENSION_PATHS), {});
  configPath = path.join(root, 'custom configuration.json');
  configurationListener(affects('coagent8.configPath'));
  assert.equal(provider.provideMcpServerDefinitions()[0].env.coagent8_CONFIG, configPath);
  assert.equal(require('../../extensions/vscode/package.json').contributes.configuration.properties['coagent8.configPath'].scope, 'machine');
  assert.equal(definition.env.coagent8_EDITOR_SETTINGS, '{}', 'contributed defaults leave config.json in effect');
  Object.assign(inspected, {
    'approval.neverAskModels': { defaultValue: [], globalValue: ['user-model'], workspaceValue: ['workspace-model'] },
    defaultBackend: { defaultValue: 'auto', workspaceValue: 'gemini', workspaceFolderValue: 'gemini' },
    'claude.defaultModel': { globalValue: 'opus' },
  });
  const before = changes;
  configurationListener(affects('coagent8.approval.neverAskModels'));
  assert.equal(changes, before + 1, 'a backend, model or approval setting refreshes the server definition');
  assert.deepEqual(JSON.parse(provider.provideMcpServerDefinitions()[0].env.coagent8_EDITOR_SETTINGS),
    { 'approval.neverAskModels': ['user-model'], 'claude.defaultModel': 'opus' }, 'only user values; a workspace cannot change backend or approval');
  fs.writeFileSync(path.join(root, 'dist/index.cjs'), 'changed bundle, same package version');
  extensionListener();
  assert.notEqual(provider.provideMcpServerDefinitions()[0].version, definition.version, 'a replacement development VSIX invalidates tool metadata despite unchanged SemVer');
  context.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(disposed, 17);
});
