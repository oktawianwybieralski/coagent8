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

/**
 * Activates the bundled extension against a scripted VS Code API.
 * @param selected - Clients the user leaves checked in each picker; null dismisses it.
 * @param buttons - Title-bar buttons (by tooltip) pressed in the first picker before it is answered.
 * @param registrations - Registration state per client for Manage CLI Chat Registrations: `owned`,
 * `outdated` (owned for another version), `manual` or `blocked`; others are absent.
 */
async function runSetupPicker({ installed = ['codex', 'claude', 'agy'], selected = ['agy'], action, command = 'coagent8.setup', failInstall = false, blocked = [], signedOut = [], vendorExtensions = [], discoverable = [], welcomed = true, activationOnly = false, configPath = '', savedMcp = false, settingsChanged = false, dirtyFiles = [], legacyState = {}, storedState, awaitState = false, awaitNotifications = 0, buttons = [], registrations = {}, extensionApiLags = false, commands = {}, alternatives = {} } = {}) {
  const handlers = {}, registrationsWritten = [], requests = [], errors = [], terminals = [], reports = [], progress = [], warnings = [], events = [], reveals = [], pickers = [];
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
    ThemeIcon: class { constructor(id) { this.id = id; } },
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
      async executeCommand(...args) {
        // A copy in this realm: option objects from the extension compare like plain values.
        requests.push(JSON.parse(JSON.stringify(args)));
        if (failInstall) throw new Error('fixture installation cancelled');
        if (args[0] === 'workbench.extensions.installExtension' && !extensionApiLags && !vendorExtensions.includes(args[1])) vendorExtensions = [...vendorExtensions, args[1]];
      },
    },
    window: {
      async showQuickPick(items, options) {
        assert.equal(options.ignoreFocusOut, true);
        pickers.push({ title: options.title, placeholder: options.placeHolder, items: Array.from(items, item => ({ client: item.client, label: item.label, description: item.description })) });
        return selected === null ? undefined : items.filter(item => selected.includes(item.client));
      },
      // Pickers open before their CLI checks and are answered once they are enabled.
      createQuickPick() {
        const listeners = {};
        let enabled = true, fills = 0;
        const snapshot = { fills: 0 };
        pickers.push(snapshot);
        return {
          items: [], selectedItems: [], busy: false, ignoreFocusOut: false, canSelectMany: false, buttons: [], dispose,
          show() { events.push('show'); assert.equal(this.busy, true); assert.equal(enabled, false); },
          hide() { listeners.hide(); },
          onDidAccept(listener) { listeners.accept = listener; return { dispose }; },
          onDidHide(listener) { listeners.hide = listener; return { dispose }; },
          onDidTriggerButton(listener) { listeners.button = listener; return { dispose }; },
          onDidTriggerItemButton(listener) { listeners.itemButton = listener; return { dispose }; },
          get enabled() { return enabled; },
          set enabled(value) {
            enabled = value;
            if (!value) return;
            setImmediate(() => {
              assert.equal(this.ignoreFocusOut, true); assert.equal(this.canSelectMany, true); assert.equal(this.busy, false);
              Object.assign(snapshot, { title: this.title, placeholder: this.placeholder, fills: ++fills, items: Array.from(this.items, item => ({ client: item.client, label: item.label, description: item.description, detail: item.detail, buttons: Array.from(item.buttons ?? [], button => button.tooltip) })), selected: Array.from(this.selectedItems, item => item.client) });
              const next = pickers.length === 1 ? buttons[fills - 1] : undefined;
              // A button named `client:tooltip` is one on that CLI's line.
              if (next?.includes(':')) {
                const [client, tooltip] = next.split(':');
                const item = this.items.find(entry => entry.client === client);
                listeners.itemButton({ item, button: item.buttons.find(button => button.tooltip === tooltip) });
                return;
              }
              if (next) { listeners.button(this.buttons.find(button => button.tooltip === next)); if (next !== 'Check Again') this.enabled = true; return; }
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
        contents: "export async function cleanupClients(options) { globalThis.recordCleanup({ clients: options.clients, apply: options.apply, origin: options.origin, uninstall: options.uninstall, actor: options.actor }); return { token: 'fixture-preview', results: (options.clients ?? ['codex', 'claude', 'agy']).map(client => ({ client, action: options.apply ? 'removed' : 'remove', message: 'fixture' })) }; }", loader: 'js',
      }));
      build.onLoad({ filter: /[\\/]integrations[\\/]setup\.ts$/ }, () => ({
        contents: "export const SETUP_CLIENTS = ['codex', 'claude', 'agy']; export const SETUP_PROVIDERS = { codex: 'codex', claude: 'claude', agy: 'agy' }; export function clientSource(client, cli) { return globalThis.vendorRoots.some(root => cli.command.startsWith(root)) ? { kind: 'vscode-extension', executable: 'vscode-extension' } : { kind: 'standalone', executable: require('node:path').resolve(cli.command) }; } export function alternativeSource(client) { return globalThis.alternatives[client]; } const appeared = new Set(); export function resolveSetupClient(client) { if (!globalThis.discoverable.includes(client)) return null; appeared.add(client); return { command: globalThis.commands[client] ?? 'fixture-' + client, argsPrefix: [], source: 'native' }; } export function readRegistrations(options) { globalThis.recordEvent('registrations'); if (!options.runtimeSource) throw new Error('missing runtime'); return SETUP_CLIENTS.map(client => { const state = globalThis.registrationStates[client]; return { client, state: state === 'outdated' ? 'owned' : state ?? 'absent', current: state !== 'outdated', message: state === 'blocked' ? 'Malformed fixture configuration.' : 'fixture' }; }); } export async function setupClients(options) { globalThis.recordEvent(options.statusOnly ? 'status' : 'setup'); if (options.origin !== 'vscode-extension') throw new Error('missing extension origin'); if (!options.statusOnly) { globalThis.recordClients(options.clients); return options.clients.map(client => ({ ...globalThis.statuses.find(status => status.client === client), action: globalThis.registrationStates[client] === 'outdated' ? 'updated' : 'installed' })); } return globalThis.statuses.filter(status => options.clients.includes(status.client)).map(status => !status.installed && appeared.has(status.client) ? { ...status, installed: true, compatibility: 'supported', authentication: 'unknown', ready: false } : status); }", loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  const statuses = ['codex', 'claude', 'agy'].map(client => {
    const present = installed.includes(client), signedIn = !signedOut.includes(client);
    return { client, installed: present, compatibility: present ? 'supported' : 'unknown', authentication: signedIn ? 'authenticated' : 'unauthenticated', ready: present && signedIn, registered: registrations[client] !== undefined, action: blocked.includes(client) ? 'blocked' : 'missing', message: 'fixture' };
  });
  vm.runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, statuses, discoverable, commands, alternatives, vendorRoots: ['openai.chatgpt', 'anthropic.claude-code', 'google.google-antigravity'].map(id => path.resolve('vendor', id)), registrationStates: registrations, setTimeout, clearTimeout, setInterval, clearInterval,
    recordClients(clients) { registrationsWritten.push(Array.from(clients)); },
    recordCleanup(call) { cleanupCalls.push({ clients: call.clients && Array.from(call.clients), apply: call.apply, ...(call.uninstall ? { origin: call.origin, uninstall: true } : {}), ...(call.actor ? { actor: call.actor } : {}) }); },
    recordEvent(name) { events.push(name); },
    require(name) { return name === 'vscode' ? vscode : require(name); },
  });
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-extension-'));
  // Onboarding state lives in the extension's global storage, which VS Code deletes on uninstall.
  const storage = path.join(extensionRoot, 'User/globalStorage/okidev.coagent8-mcp');
  const stateFile = path.join(storage, 'setup-state.json');
  const seeded = storedState ?? (welcomed ? { welcomed: true } : undefined);
  if (seeded) { fs.mkdirSync(storage, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(seeded)); }
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
    const storageFiles = fs.existsSync(storage) ? fs.readdirSync(storage) : [];
    return { registrations: registrationsWritten, terminals, requests, errors, reports, cleanupCalls, progress, warnings, events, reveals, notifications, pickers, state, stateChanged: finalState !== initialState, legacyUpdates, legacy, openedFiles, definitionChanges, storageFiles };
  } finally { fs.rmSync(extensionRoot, { recursive: true, force: true }); }
}

test('the first activation checks the CLIs once and shows one notice; later activations start nothing', async () => {
  const none = await runSetupPicker({ installed: [], welcomed: false, activationOnly: true, awaitState: true, awaitNotifications: 1 });
  assert.equal(none.notifications.length, 1);
  assert.deepEqual(none.notifications[0].actions, ['Set Up CLIs']);
  assert.deepEqual(none.state, { welcomed: true }, 'recorded before the notice is answered');
  const ready = await runSetupPicker({ installed: ['codex'], welcomed: false, activationOnly: true, awaitState: true, awaitNotifications: 1 });
  assert.match(ready.notifications[0].message, /^CoAgent8 is ready with Codex CLI\. .* Set Up CLIs installs or signs in Claude Code CLI, Antigravity CLI and adds CoAgent8 to the chats of Codex CLI\.$/);
  assert.deepEqual(ready.notifications[0].actions, ['Set Up CLIs', 'Show MCP Servers'], 'one list covers the missing CLIs and the CLI chats');
  assert.equal(ready.terminals.length, 0);
  assert.equal(ready.reveals.length, 0);
  const registered = await runSetupPicker({ welcomed: false, activationOnly: true, awaitNotifications: 1, registrations: { codex: 'owned', claude: 'owned', agy: 'owned' } });
  assert.deepEqual(registered.notifications[0].actions, ['Show MCP Servers'], 'nothing to offer when every CLI is ready and in its chat');
  const setUp = await runSetupPicker({ installed: ['codex'], welcomed: false, activationOnly: true, awaitNotifications: 1, action: 'Set Up CLIs' });
  assert.deepEqual(setUp.requests, [['coagent8.setup']]);
  for (const storedState of [{ welcomed: true }]) {
    const later = await runSetupPicker({ installed: [], activationOnly: true, storedState });
    assert.equal(later.notifications.length, 0, JSON.stringify(storedState));
    assert.equal(later.events.length, 0, 'no CLI check after the first activation');
  }
});

test('the extension keeps no state in globalState, which VS Code keeps after uninstall', async () => {
  const result = await runSetupPicker({ installed: ['codex'], welcomed: false, activationOnly: true, awaitNotifications: 1, legacyState: { unrelated: 'kept' } });
  assert.deepEqual(result.legacyUpdates, []);
  assert.deepEqual([...result.legacy], [['unrelated', 'kept']]);
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

test('the setup list opens before its checks and checks exactly the CLIs that have CoAgent8 in their chat', async () => {
  const result = await runSetupPicker({ signedOut: ['claude'], registrations: { codex: 'owned', agy: 'manual' }, selected: ['codex', 'agy'] });
  assert.deepEqual(result.events.slice(0, 3), ['show', 'status', 'registrations'], 'feedback appears before the bounded checks finish');
  const [picker] = result.pickers;
  assert.deepEqual(picker.items.map(item => [item.label, item.description]), [
    ['Codex CLI', 'Ready · in its chat'],
    ['Claude Code CLI', 'Sign-in needed (unauthenticated) · not in its chat'],
    ['Antigravity CLI', 'Ready · in its chat (manual entry, kept)'],
  ]);
  assert.deepEqual(picker.selected, ['codex', 'agy'], 'checked means CoAgent8 is in the chat; a manual entry counts');
  assert.match(picker.placeholder, /^Checked: CoAgent8 uses the CLI and is in its chat\./);
  assert.deepEqual(result.notifications, [], 'an unchanged list closes silently');
  assert.deepEqual(result.registrations, []);
  assert.deepEqual(result.cleanupCalls, []);
  assert.deepEqual(result.terminals, []);
  assert.ok(result.reveals.every(preserveFocus => preserveFocus === true), 'revealing setup output must not dismiss the picker');
});
test('a checked CLI that is missing or signed out gets its installation or sign-in offered', async () => {
  const result = await runSetupPicker({ installed: ['codex'], registrations: { codex: 'owned', claude: 'manual' }, selected: ['codex', 'claude'] });
  assert.deepEqual(result.pickers[0].items.find(item => item.client === 'claude').description, 'Not installed · in its chat (manual entry, kept)');
  assert.match(result.notifications[0].message, /^Claude Code CLI is not installed\./, 'a checked CLI is meant to work');
  assert.deepEqual(result.registrations, [], 'a manual entry is never replaced');
});
test('each CLI shows where it is installed from', async () => {
  const extension = path.join(path.resolve('vendor', 'openai.chatgpt'), 'bin', 'codex.exe');
  const result = await runSetupPicker({ discoverable: ['codex', 'claude'], commands: { codex: extension }, vendorExtensions: ['openai.chatgpt'], storedState: { welcomed: true, installedExtensions: ['openai.chatgpt'], installedClis: ['claude'] }, installed: ['codex', 'claude'], selected: null });
  assert.deepEqual(result.pickers[0].items.map(item => item.detail), [
    'Codex (OpenAI) VS Code extension, installed by CoAgent8',
    `Standalone CLI - ${path.resolve('fixture-claude')}, installed by CoAgent8`,
    undefined,
  ]);
});
test('a line with a second installation switches the CLI in config.json and refreshes the list', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-executable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const result = await runSetupPicker({ installed: ['claude'], discoverable: ['claude'], configPath: file, selected: null,
    alternatives: { claude: { kind: 'vscode-extension', executable: 'vscode-extension' } }, buttons: ['claude:Use Claude Code (Anthropic) VS Code extension'] });
  const [picker] = result.pickers;
  const claude = picker.items.find(item => item.client === 'claude');
  // The snapshot is the list after the switch: the fixture keeps offering the other installation.
  assert.match(claude.detail, /^Standalone CLI - .*fixture-claude, set in config\.json; also: Claude Code \(Anthropic\) VS Code extension$/);
  assert.deepEqual(picker.items.map(item => item.buttons.length), [0, 1, 0], 'only a CLI with two installations has the button');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backends.claude.executable, 'vscode-extension');
  assert.equal(picker.fills, 2, 'the list is refreshed after the switch');
  assert.match(result.reports.at(-1), /Set Up Coding CLIs \(Claude Code CLI switched\)/);
});
test('setup with nothing changed ends silently: one check, one log line, no notice', async () => {
  const quiet = await runSetupPicker({ registrations: { codex: 'owned', claude: 'owned', agy: 'owned' }, selected: ['codex', 'claude', 'agy'] });
  assert.deepEqual(quiet.errors, []);
  assert.equal(quiet.events.filter(event => event === 'status').length, 1, 'no second identical check');
  assert.deepEqual(quiet.notifications, []);
  assert.deepEqual(quiet.requests, []);
  assert.equal(quiet.reports.length, 1);
  assert.match(quiet.reports[0], /^\[\d\d:\d\d:\d\d\] Set Up Coding CLIs - codex: ready, added to its chat; claude: ready, added to its chat; agy: ready, added to its chat$/);
  const unchecked = await runSetupPicker({ selected: [] });
  assert.deepEqual(unchecked.notifications, [], 'leaving unregistered CLIs unchecked changes nothing');
});
test('the title-bar buttons check again and show details without closing the picker', async () => {
  const result = await runSetupPicker({ buttons: ['Show Details', 'Check Again'], selected: [] });
  assert.deepEqual(result.reveals, [true], 'details are revealed without taking focus');
  assert.equal(JSON.parse(result.reports[1]).length, 3, 'full evidence follows the summary line');
  assert.equal(result.events.filter(event => event === 'status').length, 2);
  assert.match(result.reports[2], /Set Up Coding CLIs \(Check Again\) - /);
  assert.equal(result.pickers[0].fills, 3);
});
test('checking a ready CLI adds CoAgent8 to its chat without a modal and offers to restart its extension', async () => {
  const result = await runSetupPicker({ selected: ['claude'], vendorExtensions: ['anthropic.claude-code'], action: 'Restart Extensions' });
  assert.deepEqual(result.registrations, [['claude']]);
  assert.deepEqual(result.cleanupCalls, []);
  assert.deepEqual(result.warnings, [], 'accepting the list is the confirmation');
  assert.match(result.notifications.at(-1).message, /^CoAgent8 added to the chats of Claude Code CLI\. Restart extensions so their VS Code chats load it/);
  assert.deepEqual(result.notifications.at(-1).actions, ['Restart Extensions', 'Show Details']);
  assert.deepEqual(result.requests, [['workbench.action.restartExtensionHost']]);
  assert.deepEqual(result.reveals, [], 'the outcome is logged without opening the output');
  const terminalOnly = await runSetupPicker({ selected: ['claude'] });
  assert.match(terminalOnly.notifications.at(-1).message, /^CoAgent8 added to the chats of Claude Code CLI\. New terminal sessions have it\.$/);
  assert.deepEqual(terminalOnly.notifications.at(-1).actions, ['Show Details'], 'no restart without a vendor chat extension');
});
test('unchecking removes only a CoAgent8-owned entry, tagged for uninstall; an outdated entry is updated', async () => {
  const result = await runSetupPicker({ registrations: { codex: 'owned', claude: 'outdated', agy: 'manual' }, selected: ['claude'], vendorExtensions: ['openai.chatgpt'] });
  assert.match(result.pickers[0].items.find(item => item.client === 'claude').description, /in its chat for another version; stays checked to update$/);
  assert.deepEqual(result.cleanupCalls, [{ clients: ['codex'], apply: undefined, actor: 'vscode-extension' }, { clients: ['codex'], apply: 'fixture-preview', actor: 'vscode-extension' }], 'the unchecked manual entry is kept');
  assert.deepEqual(result.registrations, [['claude']]);
  assert.match(result.notifications.at(-1).message, /^CoAgent8 updated in the chats of Claude Code CLI\. CoAgent8 removed from the chats of Codex CLI\. Restart extensions/);
  assert.deepEqual(result.progress, ['Updating CoAgent8 in CLI chats...']);
});
test('a checked CLI that needs a sign-in is signed in on request and added to its chat', async () => {
  const result = await runSetupPicker({ signedOut: ['codex'], discoverable: ['codex'], selected: ['codex'], action: ['Open Sign-in Command', 'Check Now'] });
  assert.equal(result.terminals.length, 1);
  assert.match(result.terminals[0].options.name, /^Sign in to Codex CLI/);
  assert.equal(result.terminals[0].execute, false);
  assert.equal(result.events.filter(event => event === 'status').length, 2, 'checked again after Check Now');
  assert.deepEqual(result.registrations, [['codex']], 'registration needs no sign-in');
  assert.deepEqual(result.notifications.at(-1).actions, ['Show Details']);
  const later = await runSetupPicker({ signedOut: ['codex'], discoverable: ['codex'], selected: ['codex'], action: 'Open Sign-in Command' });
  assert.equal(later.events.filter(event => event === 'status').length, 1, 'no check while the sign-in may still be running');
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
  const installed = await runSetupPicker({ installed: [], selected: ['codex'], action: 'Install VS Code Extension' });
  assert.deepEqual(installed.requests, [['workbench.extensions.installExtension', 'openai.chatgpt', { donotSync: true }]], 'machine-scoped: VS Code asks nothing about Settings Sync');
  assert.deepEqual(installed.registrations, []);
  const failed = await runSetupPicker({ installed: [], selected: ['codex', 'claude'], action: 'Install VS Code Extension', failInstall: true });
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
  assert.deepEqual(ready.registrations, [['agy']], 'the CLI installed here is added to its chat at once');
  assert.deepEqual(ready.notifications.at(-1).actions, ['Restart Extensions', 'Show Details'], 'one closing notice offers the restart');
  assert.match(ready.notifications.at(-1).message, /CoAgent8 added to the chats of Antigravity CLI\. Restart extensions/);
  const pending = await runSetupPicker({ installed: [], selected: ['agy'], vendorExtensions: ['google.google-antigravity'] });
  assert.deepEqual(pending.requests, []);
  assert.equal(pending.terminals.length, 0);
  assert.match(pending.warnings.at(-1), /Open the Antigravity view once/);
});
test('missing agy offers the Google extension, then waits for its CLI before sign-in', async () => {
  const result = await runSetupPicker({ installed: [], selected: ['agy'], discoverable: ['agy'], action: ['Install VS Code Extension', 'Open Sign-in Command'] });
  assert.deepEqual(result.requests, [['workbench.extensions.installExtension', 'google.google-antigravity', { donotSync: true }]]);
  assert.match(result.progress[0], /Antigravity CLI from the Google Antigravity extension/);
  assert.equal(result.terminals.length, 1);
  assert.match(result.terminals[0].options.name, /^Sign in to Antigravity CLI/);
  assert.deepEqual(result.registrations, [['agy']]);
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
  assert.deepEqual(found.registrations, [['claude']], 'a standalone CLI found after Check Now is added too');
  assert.deepEqual(found.notifications.at(-1).actions, ['Show Details'], 'no restart without a vendor chat extension');
});
test('setup and picker cancellation store no selection and change no registration', async () => {
  const cancelled = await runSetupPicker({ installed: ['claude'], selected: null });
  assert.equal(cancelled.stateChanged, false); assert.deepEqual(cancelled.registrations, []); assert.equal(cancelled.terminals.length, 0);
  const declined = await runSetupPicker({ installed: [], selected: ['codex'] });
  assert.deepEqual(declined.notifications.map(item => item.actions), [['Install VS Code Extension', 'Install Standalone CLI']], 'a dismissed installation offer ends without a notice');
  assert.equal(declined.stateChanged, false); assert.equal(declined.terminals.length, 0); assert.deepEqual(declined.registrations, []);
});


test('setup records only the vendor extensions it installed', async () => {
  const added = await runSetupPicker({ installed: [], selected: ['codex'], action: 'Install VS Code Extension' });
  assert.deepEqual(added.state, { welcomed: true, installedExtensions: ['openai.chatgpt'] });
  const lagging = await runSetupPicker({ installed: [], selected: ['claude'], action: 'Install VS Code Extension', extensionApiLags: true });
  assert.deepEqual(lagging.state, { welcomed: true, installedExtensions: ['anthropic.claude-code'] }, 'recorded although the extension API does not list it yet');
  const existing = await runSetupPicker({ installed: [], selected: ['codex'], vendorExtensions: ['openai.chatgpt'], action: 'Install VS Code Extension' });
  assert.deepEqual(existing.state, { welcomed: true }, 'an extension present before setup is never claimed');
});
test('a standalone installer setup opened counts as installed once a check finds the CLI', async () => {
  const opened = await runSetupPicker({ installed: [], selected: ['codex'], action: 'Install Standalone CLI' });
  assert.deepEqual(opened.state, { welcomed: true, pendingClis: ['codex'] }, 'not installed until a check finds it');
  const found = await runSetupPicker({ installed: [], selected: ['codex'], discoverable: ['codex'], action: ['Install Standalone CLI', 'Check Now'] });
  assert.deepEqual(found.state, { welcomed: true, installedClis: ['codex'] });
  const reloaded = await runSetupPicker({ storedState: { welcomed: true, pendingClis: ['claude', 'agy'] }, installed: ['claude'], selected: [] });
  assert.deepEqual(reloaded.state, { welcomed: true, pendingClis: ['agy'], installedClis: ['claude'] }, 'a check after a reload also counts');
});
test('uninstall without dependencies installed by CoAgent8 asks once, removes registrations, then the extension', async () => {
  const declined = await runSetupPicker({ command: 'coagent8.uninstall', vendorExtensions: ['openai.chatgpt'] });
  assert.deepEqual(declined.pickers, [], 'a vendor extension the user installed is not offered');
  assert.equal(declined.warnings.length, 1);
  assert.deepEqual(declined.requests, []);
  assert.deepEqual(declined.cleanupCalls, []);
  const accepted = await runSetupPicker({ command: 'coagent8.uninstall', action: 'Uninstall' });
  assert.deepEqual(accepted.cleanupCalls, [{ clients: undefined, apply: undefined, origin: 'vscode-extension', uninstall: true }, { clients: undefined, apply: 'fixture-preview', origin: 'vscode-extension', uninstall: true }]);
  assert.deepEqual(accepted.requests, [['workbench.extensions.uninstallExtension', 'okidev.coagent8-mcp']]);
  assert.match(accepted.notifications.at(-1).message, /^CoAgent8 uninstalled\. Quit VS Code and start it again to finish\.$/);
  assert.deepEqual(accepted.notifications.at(-1).actions, ['Quit VS Code']);
});
test('removing dependencies installed by CoAgent8 needs their selection and two confirmations', async () => {
  const options = { command: 'coagent8.uninstall', vendorExtensions: ['openai.chatgpt', 'anthropic.claude-code'], storedState: { welcomed: true, installedExtensions: ['openai.chatgpt', 'google.google-antigravity'] }, selected: ['codex'] };
  const once = await runSetupPicker({ ...options, action: 'Uninstall' });
  assert.deepEqual(once.pickers[0].items.map(item => item.client), ['codex'], 'only recorded extensions that are still installed');
  assert.equal(once.warnings.length, 2);
  assert.match(once.warnings[1], /^Remove Codex \(OpenAI\)\?$/);
  assert.deepEqual(once.requests, [], 'declining the second confirmation changes nothing');
  assert.deepEqual(once.cleanupCalls, []);
  const twice = await runSetupPicker({ ...options, action: ['Uninstall', 'Remove'] });
  assert.deepEqual(twice.requests, [['workbench.extensions.uninstallExtension', 'openai.chatgpt'], ['workbench.extensions.uninstallExtension', 'okidev.coagent8-mcp']]);
  assert.match(twice.notifications.at(-1).message, /^CoAgent8 and Codex \(OpenAI\) uninstalled\./);
  const kept = await runSetupPicker({ ...options, selected: [], action: 'Uninstall' });
  assert.equal(kept.warnings.length, 1, 'no second confirmation when no dependency is selected');
  assert.deepEqual(kept.requests, [['workbench.extensions.uninstallExtension', 'okidev.coagent8-mcp']]);
  assert.equal((await runSetupPicker({ ...options, selected: null })).warnings.length, 0, 'dismissing the list cancels');
});

test('removing the Antigravity extension CoAgent8 installed also deletes the agy it downloaded', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  // os.homedir() follows these; the real profile's agy must never be touched.
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const agy = path.join(home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  fs.mkdirSync(path.dirname(agy), { recursive: true });
  fs.writeFileSync(agy, 'fixture');
  fs.writeFileSync(path.join(path.dirname(agy), 'other'), 'kept');
  const result = await runSetupPicker({ command: 'coagent8.uninstall', vendorExtensions: ['google.google-antigravity'], storedState: { welcomed: true, installedExtensions: ['google.google-antigravity'] }, selected: ['agy'], action: ['Uninstall', 'Remove'] });
  assert.match(result.pickers[0].items[0].label, /Google Antigravity/);
  assert.deepEqual(result.requests, [['workbench.extensions.uninstallExtension', 'google.google-antigravity'], ['workbench.extensions.uninstallExtension', 'okidev.coagent8-mcp']]);
  assert.equal(fs.existsSync(agy), false);
  assert.ok(fs.existsSync(path.join(path.dirname(agy), 'other')), 'only the downloaded agy is deleted');
});
test('standalone CLIs CoAgent8 installed are removed through reviewed terminal commands after two confirmations', async () => {
  const options = { command: 'coagent8.uninstall', storedState: { welcomed: true, installedClis: ['claude', 'agy'] }, discoverable: ['claude'], selected: ['claude'] };
  const declined = await runSetupPicker({ ...options, action: 'Uninstall' });
  assert.deepEqual(declined.pickers[0].items, [{ client: 'claude', label: 'Claude Code CLI', description: 'standalone CLI' }], 'a CLI no longer found is not offered');
  assert.equal(declined.terminals.length, 0);
  const accepted = await runSetupPicker({ ...options, action: ['Uninstall', 'Remove'] });
  assert.equal(accepted.terminals.length, 1);
  assert.equal(accepted.terminals[0].options.name, 'Remove coding CLIs');
  assert.equal(accepted.terminals[0].execute, false, 'the user reviews and runs the commands');
  // The commands from Claude Code's uninstall documentation.
  assert.equal(accepted.terminals[0].command, process.platform === 'win32'
    ? String.raw`Remove-Item -Path "$env:USERPROFILE\.local\bin\claude.exe" -Force; Remove-Item -Path "$env:USERPROFILE\.local\share\claude" -Recurse -Force`
    : 'rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude');
  assert.deepEqual(accepted.requests, [['workbench.extensions.uninstallExtension', 'okidev.coagent8-mcp']]);
  assert.match(accepted.notifications.at(-1).message, /Press Enter in the "Remove coding CLIs" terminal to remove Claude Code CLI\. Quit VS Code/);
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
    defaultBackend: { defaultValue: 'auto', workspaceValue: 'agy', workspaceFolderValue: 'agy' },
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
  assert.equal(disposed, 14);
});
