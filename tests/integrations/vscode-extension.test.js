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
const LABELS = { codex: 'Codex CLI', claude: 'Claude Code CLI', agy: 'Antigravity CLI' };
const VENDORS = { codex: 'openai.chatgpt', claude: 'anthropic.claude-code', agy: 'google.google-antigravity' };
const SEPARATOR = -1;

/**
 * Activates the bundled extension against a scripted VS Code API and runs one command.
 * @param steps - Answers for the pickers in order: `{ client }`, `{ action }` or `{ label }` (a
 * string or RegExp) accepts that line, `{ names }` accepts those packages of a multi-select
 * picker, `{ button }` presses a title-bar button by tooltip, and `null` or the end of the
 * list dismisses the picker.
 * @param skillProfile - Points the client roots at `home`, for checks that write skill packages.
 * @param nativeRemoval - Vendor extensions the user removes in the Extensions view after the
 * command, followed by Restart Extensions, which tells the extension API they are gone.
 * @param action - Answers for notices and confirmations: each takes the first offered choice listed.
 * @param installed - CLIs installed before the command; `discoverable` CLIs are found once
 * installed, also by an installation the command starts.
 * @param registrations - Registration state per client: `owned`, `outdated` (owned for another
 * version), `manual` or `blocked`; others are absent.
 * @param extraInstallations - Installations besides the one in use, per client; one with
 * `requires` appears once that vendor extension is installed.
 */
async function runExtension({ installed = ['codex', 'claude', 'agy'], steps = [], action, command = 'coagent8.manageClis', failInstall = false, blocked = [], signedOut = [], vendorExtensions = [], discoverable = installed, welcomed = true, activationOnly = false, configPath = '', savedMcp = false, settingsChanged = false, dirtyFiles = [], legacyState = {}, storedState, installs, home, awaitState = false, awaitNotifications = 0, awaitWarnings = 0, registrations = {}, extensionApiLags = false, commands = {}, extraInstallations = {}, missingConfigured = [], openDialog, executableChecks = {}, removalRuns = true, skillProfile = false, nativeRemoval = [], inputs = [], workspaceFolders = [], remoteName } = {}) {
  const handlers = {}, registrationsWritten = [], requests = [], errors = [], terminals = [], reports = [], progress = [], warnings = [], warningDetails = [], events = [], reveals = [], pickers = [];
  const inputBoxes = [], statusMessages = [], modelRuns = [];
  // Each prompt answers with the first scripted action it offers.
  const answer = offered => [].concat(action ?? []).find(choice => offered.includes(choice));
  const cleanupCalls = [];
  const notifications = [], legacyUpdates = [], openedFiles = [];
  const legacy = new Map(Object.entries(legacyState));
  const started = new Set(), removed = new Set(), extensionListeners = [], removedVendors = new Set();
  let savedListener, configurationListener;
  let definitionChanges = 0;
  const dispose = () => {};
  const vscode = {
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    QuickInputButtons: { Back: { tooltip: 'Back' } },
    QuickPickItemKind: { Separator: SEPARATOR, Default: 0 },
    Uri: { file(file) { return { fsPath: file, toString() { return require('node:url').pathToFileURL(file).href; } }; } },
    env: remoteName ? { remoteName } : {},
    extensions: { getExtension(id) { return vendorExtensions.includes(id) ? { extensionPath: path.resolve('vendor', id), extensionUri: { scheme: 'file' } } : undefined; }, onDidChange(listener) { extensionListeners.push(listener); return { dispose }; } },
    ProgressLocation: { Notification: 15 },
    EventEmitter: class { event = () => {}; fire() { definitionChanges++; } dispose() {} },
    workspace: {
      async openTextDocument(uri) { return { uri, text: fs.readFileSync(uri.fsPath, 'utf8') }; },
      onDidChangeConfiguration(listener) { configurationListener = listener; return { dispose }; },
      createFileSystemWatcher() { return { dispose, onDidChange(listener) { savedListener = listener; return { dispose }; }, onDidCreate() { return { dispose }; }, onDidDelete() { return { dispose }; } }; },
      getConfiguration() { return { get(key, fallback) { return key === 'nodePath' ? 'node' : key === 'configPath' ? configPath : fallback; }, inspect() { return {}; } }; }, workspaceFolders: workspaceFolders.map(folder => ({ uri: { fsPath: folder } })),
      textDocuments: dirtyFiles.map(file => ({ uri: { scheme: 'file', fsPath: file }, isDirty: true })),
    },
    lm: { registerMcpServerDefinitionProvider() { return { dispose }; } },
    commands: {
      registerCommand(name, handler) { handlers[name] = handler; return { dispose }; },
      async executeCommand(...args) {
        // A copy in this realm: option objects from the extension compare like plain values.
        requests.push(JSON.parse(JSON.stringify(args)));
        if (failInstall) throw new Error('fixture installation cancelled');
        if (args[0] === 'workbench.extensions.installExtension') {
          started.add(Object.keys(VENDORS).find(client => VENDORS[client] === args[1]));
          if (!extensionApiLags && !vendorExtensions.includes(args[1])) vendorExtensions = [...vendorExtensions, args[1]];
        }
        if (args[0] === 'workbench.extensions.uninstallExtension') vendorExtensions = vendorExtensions.filter(id => id !== args[1]);
      },
    },
    window: {
      // Pickers open at once; one that loads its items is answered once it is enabled.
      createQuickPick() {
        const listeners = {};
        let enabled = true, fills = 0;
        const snapshot = { fills: 0 };
        pickers.push(snapshot);
        function respond(picker) {
          assert.equal(picker.ignoreFocusOut, true); assert.equal(picker.busy, false);
          Object.assign(snapshot, { title: picker.title, step: picker.step && `${picker.step}/${picker.totalSteps}`, placeholder: picker.placeholder, fills: ++fills, many: picker.canSelectMany, buttons: Array.from(picker.buttons, button => button.tooltip),
            items: Array.from(picker.items, item => ({ client: item.client, label: item.label, description: item.description, detail: item.detail, action: item.action, separator: item.kind === SEPARATOR, ...(item.name ? { name: item.name, picked: Array.from(picker.selectedItems).includes(item) } : {}) })) });
          const step = steps.shift();
          if (!step) { listeners.hide(); return; }
          if (step.button) {
            const button = picker.buttons.find(entry => entry.tooltip === step.button);
            assert.ok(button, `no ${step.button} button`);
            listeners.button(button);
            if (step.button === 'Show Details') picker.enabled = true;
            return;
          }
          if (step.names) {
            assert.equal(picker.canSelectMany, true);
            picker.selectedItems = picker.items.filter(entry => step.names.includes(entry.name));
            listeners.accept();
            return;
          }
          const item = picker.items.find(entry => entry.kind !== SEPARATOR && (step.client ? entry.client === step.client : step.action ? entry.action === step.action
            : step.label instanceof RegExp ? step.label.test(entry.label) : entry.label === step.label));
          assert.ok(item, `no line for ${JSON.stringify(step)} in ${JSON.stringify(picker.items.map(entry => entry.label))}`);
          picker.selectedItems = [item];
          listeners.accept();
        }
        return {
          items: [], selectedItems: [], busy: false, ignoreFocusOut: false, canSelectMany: false, matchOnDescription: false, buttons: [], dispose,
          show() {
            events.push('show');
            // A picker with known items is answered at once; a loading one once it is enabled.
            if (this.busy) assert.equal(enabled, false);
            else setImmediate(() => respond(this));
          },
          hide() { listeners.hide(); },
          onDidAccept(listener) { listeners.accept = listener; return { dispose }; },
          onDidHide(listener) { listeners.hide = listener; return { dispose }; },
          onDidTriggerButton(listener) { listeners.button = listener; return { dispose }; },
          onDidTriggerItemButton(listener) { listeners.itemButton = listener; return { dispose }; },
          get enabled() { return enabled; },
          set enabled(value) {
            enabled = value;
            if (value) setImmediate(() => respond(this));
          },
        };
      },
      async showOpenDialog() { events.push('open-dialog'); return openDialog === undefined ? undefined : [{ fsPath: openDialog }]; },
      async showInformationMessage(message, ...actions) { notifications.push({ message, actions }); return answer(actions); },
      async showTextDocument(document) { openedFiles.push(document); },
      async showWarningMessage(message, ...rest) {
        warnings.push(message);
        warningDetails.push(rest.find(item => typeof item === 'object')?.detail);
        return answer(rest.filter(item => typeof item === 'string'));
      },
      // The user cancels a wait that does not succeed on its first check.
      async withProgress(options, task) {
        progress.push(options.title);
        let cancelled = false;
        return task({ report() {} }, { get isCancellationRequested() { return cancelled; }, onCancellationRequested(listener) { setImmediate(() => { cancelled = true; listener(); }); return { dispose }; } });
      },
      createTerminal(options) {
        // An installer or removal opened here counts as run by the user.
        const target = Object.keys(LABELS).find(client => options.name === `Install ${LABELS[client]}` || options.name === `Remove ${LABELS[client]}`);
        if (target && options.name.startsWith('Install')) started.add(target);
        if (target && options.name.startsWith('Remove') && removalRuns) removed.add(target);
        const terminal = { options, dispose, show() {}, sendText(command, execute) { Object.assign(this, { command, execute }); } };
        terminals.push(terminal); return terminal;
      },
      createOutputChannel() { return { dispose, appendLine(line) { reports.push(line); }, show(preserveFocus) { reveals.push(preserveFocus); } }; },
      // Each input box takes the next scripted answer; undefined or the end of the list cancels it.
      async showInputBox(options) {
        const value = inputs.shift();
        inputBoxes.push({ title: options.title, value: options.value, valid: value === undefined ? undefined : options.validateInput(value) === null });
        return value;
      },
      setStatusBarMessage(message) { statusMessages.push(message); return { dispose }; },
      async showErrorMessage(message) { errors.push(message); },
    },
  };
  const output = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../..', 'extensions/vscode/src/extension.ts')],
    bundle: true, write: false, platform: 'node', target: 'node24', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
    plugins: [{ name: 'isolated-setup', setup(build) {
      build.onLoad({ filter: /[\\/]integrations[\\/]cleanup\.ts$/ }, () => ({
        contents: "export async function cleanupClients(options) { globalThis.setupFixture.recordCleanup({ clients: options.clients, apply: options.apply, origin: options.origin, uninstall: options.uninstall, actor: options.actor }); return { token: 'fixture-preview', results: (options.clients ?? ['codex', 'claude', 'agy']).map(client => ({ client, action: options.apply ? 'removed' : 'remove', message: 'fixture' })) }; }", loader: 'js',
      }));
      build.onLoad({ filter: /[\\/]integrations[\\/]setup\.ts$/ }, () => ({ contents: fs.readFileSync(path.resolve(__dirname, '../fixtures/vscode-extension/setup.js'), 'utf8'), loader: 'js' }));
      // The extension's own subprocess runs the bundled runtime's `models --json`.
      build.onResolve({ filter: /execution[\\/]process\.js$/ }, args => args.importer.endsWith('extension.ts') ? { path: 'model-runtime', namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /^model-runtime$/, namespace: 'fixture' }, () => ({ contents: 'export function runCommand(command, args, options) { return globalThis.setupFixture.runModels(command, args, options); }', loader: 'js' }));
    } }],
  });
  const module = { exports: {} };
  const found = client => discoverable.includes(client) && (installed.includes(client) || started.has(client)) && !removed.has(client);
  const fixture = {
    commands, extraInstallations, missingConfigured, executableChecks, registrationStates: registrations,
    vendorRoots: Object.values(VENDORS).map(id => path.resolve('vendor', id)),
    installedVendors: () => vendorExtensions,
    found,
    // The standalone file of a CLI whose removal ran is gone.
    removedFile: (client, file) => removed.has(client) && file === path.resolve('fixture-' + client),
    // The vendor extension's copy is gone once the extension was removed.
    vendorGone: client => removedVendors.has(VENDORS[client]),
    statusOf(client) {
      const present = installed.includes(client) && !removed.has(client), signedIn = !signedOut.includes(client);
      const status = { client, installed: present, compatibility: present ? 'supported' : 'unknown', authentication: signedIn ? 'authenticated' : 'unauthenticated', ready: present && signedIn, registered: registrations[client] !== undefined, action: blocked.includes(client) ? 'blocked' : 'missing', message: 'fixture' };
      // A CLI installed during the command is found, compatible and not yet signed in.
      return !present && found(client) ? { ...status, installed: true, compatibility: 'supported', authentication: 'unknown', ready: false } : status;
    },
    recordClients(clients) { registrationsWritten.push(Array.from(clients)); },
    recordCleanup(call) { cleanupCalls.push({ clients: call.clients && Array.from(call.clients), apply: call.apply, ...(call.uninstall ? { origin: call.origin, uninstall: true } : {}), ...(call.actor ? { actor: call.actor } : {}) }); },
    recordEvent(name) { events.push(name); },
    async runModels(command, args, options) {
      modelRuns.push({ args: Array.from(args).slice(1), config: options.env.coagent8_CONFIG });
      return { status: 'completed', exitCode: 0, stdout: JSON.stringify(fixtureModelReport(options.env.coagent8_CONFIG)), stderr: '' };
    },
  };
  vm.runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, setupFixture: fixture, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    require(name) { return name === 'vscode' ? vscode : require(name); },
  });
  const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-extension-'));
  // os.homedir() follows these; the real profile's ~/.coagent8 must never be touched.
  const homeDir = home ?? path.join(extensionRoot, 'home');
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ...(skillProfile ? { CODEX_HOME: process.env.CODEX_HOME, coagent8_CONFIG: process.env.coagent8_CONFIG, CODEX_CONFIG_PATH: process.env.CODEX_CONFIG_PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME } : {}) };
  process.env.HOME = homeDir; process.env.USERPROFILE = homeDir;
  if (skillProfile) {
    process.env.CODEX_HOME = path.join(homeDir, '.codex');
    process.env.coagent8_CONFIG = path.join(homeDir, '.coagent8/config.json');
    delete process.env.CODEX_CONFIG_PATH; delete process.env.CLAUDE_CONFIG_DIR; delete process.env.GEMINI_CLI_HOME;
  }
  // What CoAgent8 installed lives in ~/.coagent8, which survives an uninstall.
  const installsFile = path.join(homeDir, '.coagent8', 'installs.json');
  if (installs) { fs.mkdirSync(path.dirname(installsFile), { recursive: true }); fs.writeFileSync(installsFile, JSON.stringify(installs)); }
  // Onboarding state lives in the extension's global storage, which VS Code deletes on uninstall.
  const storage = path.join(extensionRoot, 'User/globalStorage/okidev.coagent8-mcp');
  const stateFile = path.join(storage, 'setup-state.json');
  const seeded = storedState ?? (welcomed ? { welcomed: true } : undefined);
  if (seeded) { fs.mkdirSync(storage, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(seeded)); }
  const readState = () => fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : undefined;
  const initialState = readState();
  fs.mkdirSync(path.join(extensionRoot, 'dist'));
  fs.cpSync(path.resolve(__dirname, '../../skills'), path.join(extensionRoot, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(extensionRoot, 'dist/index.cjs'), 'fixture runtime');
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: storage },
    extensionPath: extensionRoot,
    globalState: { get(key) { return legacy.get(key); }, async update(key, value) { legacyUpdates.push({ key, value }); if (value === undefined) legacy.delete(key); else legacy.set(key, value); } },
    workspaceState: { get() { return undefined; }, async update() {} },
    asAbsolutePath(relative) { return path.join(extensionRoot, relative); },
  };
  try {
    // VS Code awaits activation, which includes the first synchronization of the profile entry.
    await module.exports.activate(context);
    if (!activationOnly) await handlers[command]();
    if (nativeRemoval.length) {
      for (const id of nativeRemoval) removedVendors.add(id);
      vendorExtensions = vendorExtensions.filter(id => !nativeRemoval.includes(id));
      await Promise.all(extensionListeners.map(listener => listener()));
    }
    if (settingsChanged) await configurationListener(affects('coagent8.configPath'));
    if (savedMcp) {
      const mcp = path.join(extensionRoot, 'User/mcp.json');
      fs.mkdirSync(path.dirname(mcp), { recursive: true });
      fs.writeFileSync(mcp, JSON.stringify({ servers: { coagent8: { command: 'fixture' } } }));
      await savedListener();
    }
    // Notices the extension does not wait for settle before the results are read.
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
    // The welcome runs after activation; its locked state write completes asynchronously.
    const removing = () => (readState() ?? '').includes('removingExtensions');
    for (const deadline = Date.now() + 2000; (awaitState && readState() === initialState) || (nativeRemoval.length && removing()) || notifications.length < awaitNotifications || warnings.length < awaitWarnings;) {
      assert.ok(Date.now() < deadline, 'the onboarding state or notification did not arrive');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(steps, [], 'every scripted picker step was used');
    const finalState = readState();
    const state = finalState === undefined ? undefined : JSON.parse(finalState);
    const storageFiles = fs.existsSync(storage) ? fs.readdirSync(storage) : [];
    const installRecord = fs.existsSync(installsFile) ? JSON.parse(fs.readFileSync(installsFile, 'utf8')) : undefined;
    const configFile = configPath || path.join(homeDir, '.coagent8', 'config.json');
    // The parsed file; a test that writes malformed JSON reads its text instead.
    const configText = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : undefined;
    let config = configText;
    try { if (configText !== undefined) config = JSON.parse(configText); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    const menus = pickers;
    return { inputBoxes, statusMessages, modelRuns, installs: installRecord, config, registrations: registrationsWritten, terminals, requests, errors, reports, cleanupCalls, progress, warnings, warningDetails, events, reveals, notifications, pickers, menus, state, stateChanged: finalState !== initialState, legacyUpdates, legacy, openedFiles, definitionChanges, storageFiles };
  } finally {
    for (const [key, value] of Object.entries(savedHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  }
}
/**
 * The model view `coagent8 models --json` returns for a configuration file: two Codex models
 * and one agy model, tagged by the file's lists, else by a 20 USD price rule.
 */
function fixtureModelReport(configFile) {
  const governance = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).governance ?? {} : {};
  const models = { allow: [], ask: [], deny: [], ...governance.models };
  // `runs`: the name a default model runs as (agy's `<id>-<effort>`), which its rules see.
  const row = (backend, model, output, { runs, ...extra } = {}) => {
    const names = [runs ?? model, model];
    const rule = ['deny', 'ask', 'allow'].find(name => models[name].some(listed => names.includes(listed)));
    const ruleEntry = rule && models[rule].find(listed => names.includes(listed));
    const required = rule ? rule === 'ask' : output === null || output >= (governance.askAbovePrice === undefined ? 20 : governance.askAbovePrice ?? Infinity);
    const basis = rule ?? (output === null ? 'unpriced' : required ? 'above-limit' : 'priced');
    return { backend, model, efforts: [], price: { outputUsdPerMTok: output, match: output === null ? 'unknown' : 'exact' },
      approval: { required, denied: rule === 'deny', basis, reason: 'fixture', rememberable: false, ...(ruleEntry ? { ruleEntry } : {}) }, ...extra };
  };
  return {
    scope: 'models', prices: null, recommendations: [],
    backends: { codex: { installed: true, allowed: true }, claude: { installed: false, allowed: true }, agy: { installed: true, allowed: true } },
    selection: [row('codex', 'gpt-6-luna', 0.5, { defaultSource: 'catalog' }), row('codex', 'gpt-6-astra', 50), row('codex', 'gpt-7-nova', null), row('agy', 'gemini-3.8-flash', 3.75, { defaultSource: 'catalog', runs: 'gemini-3.8-flash-low' })],
  };
}
/** The actions of a menu's lines, information lines and separators left out. */
const actionsOf = menu => menu.items.filter(item => item.action).map(item => item.action);

test('the first activation checks the CLIs once and shows one notice; later activations start nothing', async () => {
  const none = await runExtension({ installed: [], welcomed: false, activationOnly: true, awaitState: true, awaitNotifications: 1 });
  assert.equal(none.notifications.length, 1);
  assert.deepEqual(none.notifications[0].actions, ['Manage CLIs']);
  assert.deepEqual(none.state, { welcomed: true }, 'recorded before the notice is answered');
  const ready = await runExtension({ installed: ['codex'], welcomed: false, activationOnly: true, awaitState: true, awaitNotifications: 1 });
  assert.match(ready.notifications[0].message, /^CoAgent8 is ready with Codex CLI\. .* Manage CLIs installs or signs in Claude Code CLI, Antigravity CLI and adds CoAgent8 to the chats of Codex CLI\.$/);
  assert.deepEqual(ready.notifications[0].actions, ['Manage CLIs', 'Show MCP Servers'], 'one menu covers the missing CLIs and the CLI chats');
  assert.equal(ready.terminals.length, 0);
  assert.equal(ready.reveals.length, 0);
  const registered = await runExtension({ welcomed: false, activationOnly: true, awaitNotifications: 1, registrations: { codex: 'owned', claude: 'owned', agy: 'owned' } });
  assert.deepEqual(registered.notifications[0].actions, ['Show MCP Servers'], 'nothing to offer when every CLI is ready and in its chat');
  const manage = await runExtension({ installed: ['codex'], welcomed: false, activationOnly: true, awaitNotifications: 1, action: 'Manage CLIs' });
  assert.deepEqual(manage.requests, [['coagent8.manageClis']]);
  for (const storedState of [{ welcomed: true }]) {
    const later = await runExtension({ installed: [], activationOnly: true, storedState });
    assert.equal(later.notifications.length, 0, JSON.stringify(storedState));
    assert.deepEqual(later.events, ['registrations'], 'no CLI check after the first activation; only the chat configuration files are read');
    assert.equal(later.stateChanged, false);
  }
});

test('an activation with an outdated CLI chat registration offers to update the CLI chats once per runtime', async () => {
  const declined = await runExtension({ activationOnly: true, registrations: { codex: 'owned', claude: 'outdated', agy: 'outdated' }, awaitState: true, awaitWarnings: 1 });
  assert.equal(declined.warnings.length, 1);
  assert.match(declined.warnings[0], /^CoAgent8 was updated, but the chats of Claude Code CLI, Antigravity CLI still start the previous version\./);
  assert.deepEqual(declined.events, ['registrations'], 'the check reads files and starts no CLI');
  assert.match(declined.state.updateOffered, /#[0-9a-f]{64}$/);
  const updated = await runExtension({ activationOnly: true, registrations: { claude: 'outdated' }, awaitWarnings: 1, awaitNotifications: 1, action: 'Update CLI Chats' });
  assert.deepEqual(updated.registrations, [['claude']], 'the button updates the outdated chats directly');
  assert.match(updated.notifications.at(-1).message, /^CoAgent8 updated in the chats of Claude Code CLI\./);
  const again = await runExtension({ activationOnly: true, registrations: { claude: 'outdated' }, storedState: declined.state });
  assert.deepEqual(again.warnings, [], 'the same runtime is offered once');
  assert.deepEqual(again.events, [], 'and reads nothing again');
  const roots = await runExtension({ activationOnly: true, workspaceFolders: [path.resolve('one'), path.resolve('two')], registrations: { claude: 'outdated' }, awaitWarnings: 1 });
  assert.deepEqual(roots.errors, [], 'a multi-root window reads the registrations too');
  assert.match(roots.warnings[0], /^CoAgent8 was updated, but the chats of Claude Code CLI still start the previous version./);
});

test('the extension keeps no state in globalState, which VS Code keeps after uninstall', async () => {
  const result = await runExtension({ installed: ['codex'], welcomed: false, activationOnly: true, awaitNotifications: 1, legacyState: { unrelated: 'kept' } });
  assert.deepEqual(result.legacyUpdates, []);
  assert.deepEqual([...result.legacy], [['unrelated', 'kept']]);
});

test('Open Configuration creates defaults only when absent and opens malformed existing JSON unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-editor-'));
  const file = path.join(directory, 'custom', 'config.json');
  const previous = process.env.coagent8_CONFIG;
  process.env.coagent8_CONFIG = file;
  try {
    const created = await runExtension({ command: 'coagent8.openConfiguration' });
    assert.equal(created.errors.length, 0);
    assert.equal(created.openedFiles[0].uri.fsPath, file);
    const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(defaults.$schema, /schemas\/config.schema.json$/);
    delete defaults.$schema;
    assert.deepEqual(defaults, require('../../src/config.ts').validateConfig({}));
    fs.writeFileSync(file, '{ malformed existing configuration');
    const existing = await runExtension({ command: 'coagent8.openConfiguration' });
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
  const cancelled = await runExtension(options);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(fs.existsSync(file + '.backup'), false);
  assert.match(cancelled.warnings[0], /config\.json\.backup, replacing an earlier backup/);
  const dirty = await runExtension({ ...options, action: 'Reset Configuration', dirtyFiles: [file] });
  assert.match(dirty.errors[0], /Save or revert/);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  const reset = await runExtension({ ...options, action: ['Reset Configuration', 'Open Settings'] });
  assert.deepEqual(reset.errors, []);
  assert.equal(fs.readFileSync(file + '.backup', 'utf8'), first);
  const defaults = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(defaults.$schema, /schemas\/config\.schema\.json$/);
  delete defaults.$schema;
  assert.deepEqual(defaults, require('../../src/config.ts').validateConfig({}));
  assert.equal(reset.openedFiles[0].uri.fsPath, file);
  assert.deepEqual(reset.requests, [['coagent8.openSettings']]);
  const second = fs.readFileSync(file, 'utf8');
  await runExtension({ ...options, action: 'Reset Configuration' });
  assert.equal(fs.readFileSync(file + '.backup', 'utf8'), second, 'the next reset replaces the single backup');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['config.json', 'config.json.backup'], 'no lock, temporary or extra backup files remain');
});

test('settings and MCP server commands open the native VS Code views', async () => {
  assert.deepEqual((await runExtension({ command: 'coagent8.openSettings' })).requests, [['workbench.action.openSettings', '@ext:okidev.coagent8-mcp']]);
  assert.deepEqual((await runExtension({ command: 'coagent8.manageMcpServers' })).requests, [['workbench.mcp.listServer']]);
});

test('every registered command is contributed with a title and every contributed command is registered', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../extensions/vscode/src/extension.ts'), 'utf8');
  const registered = [...source.matchAll(/register\('(coagent8\.[A-Za-z]+)'/g)].map(match => match[1]).sort();
  const contributed = require('../../extensions/vscode/package.json').contributes.commands;
  assert.deepEqual(contributed.map(item => item.command).sort(), registered);
  // The Command Palette shows the category as a prefix: CoAgent8: Manage Coding CLIs.
  assert.ok(contributed.every(item => item.category === 'CoAgent8' && !item.title.startsWith('CoAgent8')));
});

test('the user configPath setting overrides the environment for editing and rejects relative paths', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-config-setting-'));
  const file = path.join(directory, 'custom configuration.json');
  const previous = process.env.coagent8_CONFIG;
  process.env.coagent8_CONFIG = path.join(directory, 'environment configuration.json');
  try {
    const result = await runExtension({ command: 'coagent8.openConfiguration', configPath: file });
    assert.equal(result.errors.length, 0);
    assert.equal(result.openedFiles[0].uri.fsPath, file);
    assert.equal(fs.existsSync(process.env.coagent8_CONFIG), false, 'the environment override must not be created instead');
    fs.writeFileSync(file, '{ malformed preserved');
    const existing = await runExtension({ command: 'coagent8.openConfiguration', configPath: file });
    assert.equal(existing.openedFiles[0].text, '{ malformed preserved');
    const invalid = await runExtension({ command: 'coagent8.openConfiguration', configPath: 'relative/config.json' });
    assert.match(invalid.errors[0], /absolute path/);
  } finally {
    if (previous === undefined) delete process.env.coagent8_CONFIG; else process.env.coagent8_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('settings and filesystem MCP changes invalidate provider definitions without restarting the window or other extensions', async () => {
  const settings = await runExtension({ activationOnly: true, settingsChanged: true });
  assert.equal(settings.definitionChanges, 1);
  assert.deepEqual(settings.requests, []);
  const saved = await runExtension({ activationOnly: true, savedMcp: true });
  assert.equal(saved.definitionChanges, 1, 'filesystem writes from the MCP UI also invalidate the provider');
  assert.deepEqual(saved.requests, []);
  assert.equal(saved.terminals.length, 0);
});


test('the CLI list opens before its checks and shows each CLI with its state and chat', async () => {
  const result = await runExtension({ signedOut: ['claude'], registrations: { codex: 'owned', agy: 'manual' } });
  assert.equal(result.events[0], 'registrations', 'activation reads the chat configuration files once');
  assert.deepEqual(result.events.slice(1, 4), ['show', 'status', 'registrations'], 'feedback appears before the bounded checks finish');
  const [list] = result.menus;
  assert.equal(list.title, 'Manage Coding CLIs');
  assert.deepEqual(list.items.map(item => [item.label, item.description]), [
    ['$(pass-filled) Codex CLI', 'Ready · in its chat'],
    ['$(warning) Claude Code CLI', 'Sign-in needed (unauthenticated) · not in its chat'],
    ['$(pass-filled) Antigravity CLI', 'Ready · in its chat (manual entry, kept)'],
    ['All CLIs', undefined],
    ['$(plug) Add CoAgent8 to All CLI Chats', 'Claude Code CLI'],
  ], 'a compatible CLI needs no sign-in to be added; a manual entry stays');
  assert.equal(list.items[0].detail, `Standalone CLI - ${path.resolve('fixture-codex')}`, 'the installation in use is under each CLI');
  const missing = await runExtension({ installed: [] });
  assert.ok(missing.menus[0].items.every(item => item.label.startsWith('$(circle-slash) ') && item.detail === undefined));
  assert.deepEqual(list.buttons, ['Check Again', 'Show Details'], 'the list has no Back button');
  assert.match(list.placeholder, /^Choose a CLI/);
  assert.deepEqual(result.notifications, [], 'a dismissed list changes nothing');
  assert.deepEqual(result.registrations, []);
  assert.deepEqual(result.cleanupCalls, []);
  assert.deepEqual(result.terminals, []);
  assert.ok(result.reveals.every(preserveFocus => preserveFocus === true), 'revealing setup output must not dismiss the picker');
  const all = await runExtension({ registrations: { codex: 'owned', claude: 'owned', agy: 'owned' } });
  assert.equal(all.menus[0].items.length, 3, 'no action for several chats when none has anything to do');
  assert.match(all.reports[0], /^\[\d\d:\d\d:\d\d\] Manage Coding CLIs - codex: ready, added to its chat; claude: ready, added to its chat; agy: ready, added to its chat$/);
});
test('a CLI menu lists its installations first, the one in use marked, others as actions', async () => {
  const codex = path.join(path.resolve('vendor', 'openai.chatgpt'), 'bin', 'codex.exe');
  const extension = await runExtension({ commands: { codex }, vendorExtensions: ['openai.chatgpt'], steps: [{ client: 'codex' }] });
  assert.equal(extension.menus[0].items[0].detail, 'Codex (OpenAI) VS Code extension');
  assert.deepEqual(extension.menus[1].items.slice(0, 2).map(item => [item.label, item.description, item.action]),
    [['Installations', undefined, undefined], ['$(pass-filled) Codex (OpenAI) VS Code extension', 'in use', undefined]]);
  const npm = path.resolve('npm-claude.js');
  const two = await runExtension({ extraInstallations: { claude: [{ kind: 'npm', executable: npm, file: npm }] }, steps: [{ client: 'claude' }] });
  assert.deepEqual(two.menus[1].items.slice(1, 3).map(item => [item.label, item.description, item.action]), [
    ['$(pass-filled) Standalone CLI', `${path.resolve('fixture-claude')} · in use`, undefined],
    ['$(circle-large-outline) npm package', npm, 'use'],
  ]);
});
test('the title-bar buttons check again and show details without closing the list', async () => {
  const result = await runExtension({ steps: [{ button: 'Show Details' }, { button: 'Check Again' }] });
  assert.deepEqual(result.reveals, [true], 'details are revealed without taking focus');
  assert.equal(JSON.parse(result.reports[1]).length, 3, 'full evidence follows the summary line');
  assert.equal(result.events.filter(event => event === 'status').length, 2);
  assert.match(result.reports[2], /Manage Coding CLIs \(Check Again\) - /);
  assert.equal(result.menus[0].fills, 3, 'shown, re-enabled after Show Details, refilled by Check Again');
});
test('the actions for several CLI chats add or update every one at once without a modal', async () => {
  const added = await runExtension({ steps: [{ label: '$(plug) Add CoAgent8 to All CLI Chats' }], signedOut: ['agy'], registrations: { codex: 'manual' }, vendorExtensions: ['anthropic.claude-code'], action: 'Restart Extensions' });
  assert.deepEqual(added.registrations, [['claude', 'agy']]);
  assert.deepEqual(added.warnings, [], 'choosing the action is the confirmation');
  assert.deepEqual(added.progress, ['Updating CoAgent8 in CLI chats...']);
  assert.match(added.notifications.at(-1).message, /^CoAgent8 added to the chats of Claude Code CLI, Antigravity CLI\. Restart extensions so their VS Code chats load it/);
  assert.deepEqual(added.requests, [['workbench.action.restartExtensionHost']]);
  assert.equal(added.menus.length, 1, 'the action closes the list');
  const updated = await runExtension({ steps: [{ label: '$(sync) Update CoAgent8 in All CLI Chats' }], registrations: { codex: 'owned', claude: 'outdated', agy: 'owned' } });
  assert.equal(updated.menus[0].items.at(-1).description, 'Claude Code CLI');
  assert.deepEqual(updated.registrations, [['claude']]);
  assert.match(updated.notifications.at(-1).message, /^CoAgent8 updated in the chats of Claude Code CLI\. New terminal sessions have it\.$/);
  assert.deepEqual(updated.notifications.at(-1).actions, ['Show Details'], 'no restart without a vendor chat extension');
});
test('a CLI menu reuses the list checks and offers only the actions its state allows', async () => {
  const ready = await runExtension({ steps: [{ client: 'codex' }], registrations: { codex: 'owned' } });
  const menu = ready.menus[1];
  assert.equal(menu.title, 'Codex CLI: Ready · in its chat');
  assert.deepEqual(menu.buttons, ['Back', 'Check Again', 'Show Details']);
  assert.ok(menu.items.every(item => item.detail === undefined), 'no second lines');
  assert.deepEqual(menu.items.map(item => item.separator ? `-- ${item.label}` : item.label), [
    '-- Installations', `$(pass-filled) Standalone CLI`,
    '-- Install', '$(extensions) Install VS Code Extension', '$(folder-opened) Choose Executable',
    '-- Skills', '$(book) Manage Skills',
    '-- Remove', '$(debug-disconnect) Remove CoAgent8 from Its Chat',
  ], 'sections with icons; a section without actions is left out');
  assert.equal(ready.events.filter(event => event === 'status').length, 1, 'the menu reuses the checks the list ran');
  const missing = await runExtension({ installed: ['claude'], steps: [{ client: 'codex' }] });
  assert.equal(missing.menus[1].title, 'Codex CLI: Not installed · not in its chat');
  assert.deepEqual(actionsOf(missing.menus[1]), ['installExtension', 'installStandalone', 'chooseExecutable', 'skills']);
  assert.ok(!missing.menus[1].items.some(item => item.separator && item.label === 'Installations'), 'no empty section');
  assert.equal(missing.menus[1].placeholder, 'Choose an action');
  const outdated = await runExtension({ signedOut: ['claude'], registrations: { claude: 'outdated' }, steps: [{ client: 'claude' }] });
  assert.deepEqual(actionsOf(outdated.menus[1]), ['installExtension', 'chooseExecutable', 'signIn', 'connect', 'skills', 'disconnect']);
  assert.equal(outdated.menus[1].items.find(item => item.action === 'connect').label, '$(sync) Update CoAgent8 in Its Chat');
  const manual = await runExtension({ registrations: { agy: 'manual' }, steps: [{ client: 'agy' }] });
  assert.deepEqual(actionsOf(manual.menus[1]), ['installExtension', 'chooseExecutable', 'skills'], 'a manual entry is never replaced or removed');
});
test('Back returns from a CLI menu to the list, which checks again; Check Again checks only that CLI', async () => {
  const result = await runExtension({ steps: [{ client: 'claude' }, { button: 'Check Again' }, { button: 'Back' }] });
  assert.equal(result.menus.length, 3);
  assert.equal(result.menus[1].fills, 2);
  assert.equal(result.menus[2].title, 'Manage Coding CLIs');
  assert.ok(result.reports.some(line => /\] Claude Code CLI \(Check Again\) - claude: ready$/.test(line)));
  assert.equal(result.events.filter(event => event === 'status').length, 3, 'list, Check Again, list again');
});
test('Add CoAgent8 to Its Chat registers the CLI and offers to restart its extension; the menu reopens', async () => {
  const result = await runExtension({ steps: [{ client: 'claude' }, { action: 'connect' }], vendorExtensions: ['anthropic.claude-code'], action: 'Restart Extensions' });
  assert.deepEqual(result.registrations, [['claude']]);
  assert.deepEqual(result.cleanupCalls, []);
  assert.deepEqual(result.warnings, [], 'choosing the action is the confirmation');
  assert.match(result.notifications.at(-1).message, /^CoAgent8 added to the chats of Claude Code CLI\. Restart extensions so their VS Code chats load it/);
  assert.deepEqual(result.notifications.at(-1).actions, ['Restart Extensions', 'Show Details']);
  assert.deepEqual(result.requests, [['workbench.action.restartExtensionHost']]);
  assert.deepEqual(result.reveals, [], 'the outcome is logged without opening the output');
  assert.equal(result.menus.length, 3, 'the menu reopens with fresh checks');
  const terminalOnly = await runExtension({ steps: [{ client: 'claude' }, { action: 'connect' }] });
  assert.match(terminalOnly.notifications.at(-1).message, /^CoAgent8 added to the chats of Claude Code CLI\. New terminal sessions have it\.$/);
});
test('Remove CoAgent8 from Its Chat removes only the entry CoAgent8 wrote, tagged as the extension', async () => {
  const result = await runExtension({ registrations: { codex: 'owned' }, steps: [{ client: 'codex' }, { action: 'disconnect' }] });
  assert.deepEqual(result.cleanupCalls, [{ clients: ['codex'], apply: undefined, actor: 'vscode-extension' }, { clients: ['codex'], apply: 'fixture-preview', actor: 'vscode-extension' }]);
  assert.match(result.notifications.at(-1).message, /^CoAgent8 removed from the chats of Codex CLI\. New terminal sessions have it\.$/);
  assert.deepEqual(result.registrations, []);
});
test('Sign In opens the sign-in command for review and checks again on request', async () => {
  const result = await runExtension({ signedOut: ['codex'], steps: [{ client: 'codex' }, { action: 'signIn' }], action: 'Check Now' });
  assert.equal(result.terminals.length, 1);
  assert.match(result.terminals[0].options.name, /^Sign in to Codex CLI/);
  assert.match(result.terminals[0].command, /'fixture-codex' 'login'$/);
  assert.equal(result.terminals[0].execute, false);
  assert.deepEqual(result.registrations, [], 'signing in never registers');
  assert.equal(result.events.filter(event => event === 'status').length, 2, 'the menu checks again after Check Now');
});
test('Install VS Code Extension installs the vendor extension for this machine and records it', async () => {
  const codex = path.join(path.resolve('vendor', 'openai.chatgpt'), 'bin', 'codex.exe');
  const result = await runExtension({ installed: [], discoverable: ['codex'], commands: { codex }, steps: [{ client: 'codex' }, { action: 'installExtension' }] });
  assert.deepEqual(result.requests, [['workbench.extensions.installExtension', 'openai.chatgpt', { donotSync: true }]], 'machine-scoped: VS Code asks nothing about Settings Sync');
  assert.deepEqual(result.installs, { installedExtensions: ['openai.chatgpt'] }, 'kept in ~/.coagent8, which survives an uninstall');
  assert.match(result.progress[0], /^Waiting for Codex CLI from the Codex \(OpenAI\) extension/);
  assert.deepEqual(result.registrations, [], 'installation never registers');
  assert.equal(result.menus[2].title, 'Codex CLI: Sign-in needed (unknown) · not in its chat', 'the menu reopens on the next steps');
  assert.deepEqual(actionsOf(result.menus[2]), ['installStandalone', 'chooseExecutable', 'signIn', 'connect', 'skills', 'uninstallExtension']);
  const lagging = await runExtension({ installed: [], discoverable: ['claude'], commands: { claude: path.resolve('vendor', 'anthropic.claude-code', 'claude.exe') }, steps: [{ client: 'claude' }, { action: 'installExtension' }], extensionApiLags: true });
  assert.deepEqual(lagging.installs, { installedExtensions: ['anthropic.claude-code'] }, 'recorded although the extension API does not list it yet');
  const failed = await runExtension({ installed: [], steps: [{ client: 'codex' }, { action: 'installExtension' }], failInstall: true });
  // The fixture's error comes from another realm, so the extension shows its generic text.
  assert.deepEqual(failed.errors, ['Codex CLI: Action failed or was cancelled; retry.']);
  assert.equal(failed.installs, undefined);
  assert.equal(failed.menus.length, 3, 'the menu stays open to retry');
});
test('an extension copy installed beside a standalone CLI is selected only when the user chooses it', async () => {
  const extraInstallations = { codex: [{ kind: 'vscode-extension', executable: 'vscode-extension', file: path.resolve('vendor', 'openai.chatgpt', 'bin', 'codex.exe'), requires: 'openai.chatgpt' }] };
  const options = { extraInstallations, steps: [{ client: 'codex' }, { action: 'installExtension' }] };
  const used = await runExtension({ ...options, action: 'Use It' });
  const offer = used.notifications.find(item => /still uses/.test(item.message));
  assert.match(offer.message, /^Codex CLI still uses Standalone CLI - .*fixture-codex\. Use Codex \(OpenAI\) VS Code extension instead\?$/);
  assert.deepEqual(offer.actions, ['Use It', 'Keep Current']);
  assert.equal(used.config.backends.codex.executable, 'vscode-extension', 'the runtime uses the extension copy from now on');
  assert.deepEqual(used.installs, { installedExtensions: ['openai.chatgpt'] });
  const kept = await runExtension({ ...options, steps: [{ client: 'codex' }, { action: 'installExtension' }], action: 'Keep Current' });
  assert.equal(kept.config, undefined, 'the CLI in use stays');
});
test('Install Standalone CLI inserts the official installer for review and counts it once a check finds the CLI', async () => {
  const opened = await runExtension({ installed: ['claude'], discoverable: ['claude'], steps: [{ client: 'agy' }, { action: 'installStandalone' }] });
  assert.equal(opened.terminals.length, 1);
  assert.equal(opened.terminals[0].options.name, 'Install Antigravity CLI');
  assert.match(opened.terminals[0].command, /https:\/\/antigravity\.google\/cli\/install\.(ps1|sh)/);
  assert.equal(opened.terminals[0].execute, false);
  assert.equal(opened.terminals[0].options.shellPath, process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  assert.deepEqual(opened.notifications[0].actions, ['Check Now', 'Reload Window']);
  assert.deepEqual(opened.installs, { pendingClis: ['agy'] }, 'not installed until a check finds it');
  assert.deepEqual(opened.registrations, []);
  const found = await runExtension({ installed: [], discoverable: ['claude'], steps: [{ client: 'claude' }, { action: 'installStandalone' }], action: 'Check Now' });
  assert.deepEqual(found.installs, { installedClis: ['claude'] });
  assert.equal(found.config, undefined, 'the only installation needs no selection');
  assert.ok(actionsOf(found.menus[2]).includes('uninstallStandalone'), 'the menu reopens with the removal of what it installed');
  const stale = await runExtension({ installed: [], discoverable: [], steps: [{ client: 'claude' }, { action: 'installStandalone' }], action: 'Check Now' });
  assert.match(stale.warnings.at(-1), /^Claude Code CLI was not found\. Reload the window/);
  assert.deepEqual(stale.requests, []);
  const reloaded = await runExtension({ installed: [], discoverable: [], steps: [{ client: 'claude' }, { action: 'installStandalone' }], action: ['Check Now', 'Reload Window'] });
  assert.deepEqual(reloaded.requests, [['workbench.action.reloadWindow']]);
  assert.equal(reloaded.menus.length, 2, 'a reload closes the menu');
});
test('an installer CoAgent8 opened counts once a later check finds its CLI, also after a reload', async () => {
  const reloaded = await runExtension({ installs: { pendingClis: ['claude', 'agy'] }, installed: ['claude'] });
  assert.deepEqual(reloaded.installs, { pendingClis: ['agy'], installedClis: ['claude'] });
  const legacy = await runExtension({ storedState: { welcomed: true, pendingClis: ['claude'] }, installed: ['claude'] });
  assert.deepEqual(legacy.installs, { installedClis: ['claude'] }, 'a list an earlier version kept in the extension storage moves to ~/.coagent8');
  assert.deepEqual(legacy.state, { welcomed: true });
  const removed = await runExtension({ installs: { installedExtensions: ['openai.chatgpt', 'anthropic.claude-code'] }, vendorExtensions: ['anthropic.claude-code'] });
  assert.deepEqual(removed.installs, { installedExtensions: ['anthropic.claude-code'] }, 'a vendor extension removed in the meantime leaves the record');
});
test('an unavailable preference for the extension copy is shown and replaced only by a standalone choice', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-missing-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const client of ['claude', 'agy']) {
    const config = path.join(root, client + '.json');
    const content = JSON.stringify({ backends: { [client]: { executable: 'vscode-extension' } } });
    fs.writeFileSync(config, content);
    const options = { configPath: config, installed: [], discoverable: [], missingConfigured: [client] };
    const shown = await runExtension({ ...options, steps: [{ client }] });
    assert.match(shown.menus[1].items.find(item => item.label === '$(warning) Selected CLI not found').description, / VS Code extension$/);
    assert.ok(actionsOf(shown.menus[1]).includes('discovery'));
    await runExtension({ ...options, steps: [{ client }, { action: 'installExtension' }] });
    assert.equal(fs.readFileSync(config, 'utf8'), content, 'extension installation keeps the preference');
    const standalone = await runExtension({ ...options, steps: [{ client }, { action: 'installStandalone' }] });
    assert.equal(standalone.terminals.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(config, 'utf8')).backends[client].executable, undefined, 'standalone choice restores discovery');
    assert.deepEqual(standalone.errors, []);
  }
});
test('the Google Antigravity extension without its download yet offers no second installation', async () => {
  const result = await runExtension({ installed: [], discoverable: [], vendorExtensions: ['google.google-antigravity'], steps: [{ client: 'agy' }] });
  assert.match(result.menus[0].items.find(item => item.client === 'agy').description, /^Downloading - /);
  assert.deepEqual(actionsOf(result.menus[1]), ['chooseExecutable', 'skills']);
  assert.match(result.menus[1].placeholder, /downloads this CLI when its view first opens$/);
  const downloaded = await runExtension({ discoverable: ['agy'], commands: { agy: path.resolve('vendor', 'google.google-antigravity', 'agy.exe') }, steps: [{ client: 'agy' }] });
  assert.match(downloaded.menus[0].items.find(item => item.client === 'agy').detail, /^Standalone CLI - ~\/\.gemini\/bin\/agy/, 'without the Google extension its binary is a standalone CLI');
});
test('another installation is selected in config.json from its line; automatic discovery removes the choice', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-executable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const extraInstallations = { claude: [{ kind: 'vscode-extension', executable: 'vscode-extension', file: path.resolve('vendor', 'anthropic.claude-code', 'claude.exe') }] };
  const used = await runExtension({ configPath: file, extraInstallations, steps: [{ client: 'claude' }, { label: /Claude Code \(Anthropic\) VS Code extension$/ }] });
  const line = used.menus[1].items.find(item => item.action === 'use');
  assert.equal(line.label, '$(circle-large-outline) Claude Code (Anthropic) VS Code extension');
  assert.equal(line.description, undefined, 'an extension copy needs no path');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backends.claude.executable, 'vscode-extension');
  assert.ok(actionsOf(used.menus[2]).includes('discovery'), 'the menu reopens with the choice set');
  assert.match(used.menus[2].items[1].description, /in use, selected$/);
  const single = await runExtension({ configPath: file, steps: [{ client: 'claude' }] });
  assert.ok(!actionsOf(single.menus[1]).includes('discovery'), 'with one installation the selection changes nothing');
  const discovery = await runExtension({ configPath: file, extraInstallations, steps: [{ client: 'claude' }, { action: 'discovery' }] });
  assert.deepEqual(discovery.errors, []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backends.claude.executable, undefined);
});
test('Choose Executable uses a file only after the compatibility check accepts it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-choose-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const chosen = path.join(directory, 'tools', 'codex.exe');
  const accepted = await runExtension({ configPath: path.join(directory, 'accepted.json'), openDialog: chosen, steps: [{ client: 'codex' }, { action: 'chooseExecutable' }] });
  assert.equal(accepted.config.backends.codex.executable, chosen);
  assert.ok(accepted.progress.includes('Checking codex.exe...'));
  assert.match(accepted.notifications.at(-1).message, /^Codex CLI now uses Standalone CLI - .*codex\.exe 9\.9\.9\.$/);
  const refused = await runExtension({ configPath: path.join(directory, 'refused.json'), openDialog: chosen, executableChecks: { [chosen]: 'codex.exe is not a compatible codex CLI: Required CLI controls are missing.' }, steps: [{ client: 'codex' }, { action: 'chooseExecutable' }] });
  assert.match(refused.errors[0], /^Codex CLI: codex\.exe is not a compatible codex CLI/);
  assert.equal(refused.config, undefined, 'config.json is not changed');
  assert.equal(refused.menus.length, 3, 'the menu reopens');
  const cancelled = await runExtension({ configPath: path.join(directory, 'cancelled.json'), steps: [{ client: 'codex' }, { action: 'chooseExecutable' }] });
  assert.ok(cancelled.events.includes('open-dialog'));
  assert.ok(!cancelled.events.includes('check-executable'));
  assert.equal(cancelled.config, undefined);
});
test('Manage Skills installs and toggles only selected packages; picker cancellation keeps persisted bytes', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-ui-skills-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.gemini/config/skills/coagent8-review/SKILL.md');
  const archived = path.join(home, '.coagent8/disabled-skills/agy/coagent8-review/SKILL.md');
  const options = { home, skillProfile: true, command: 'coagent8.manageSkills' };
  const run = (action, extra = {}) => runExtension({ ...options, steps: [{ client: 'agy' }, { action }, { names: ['coagent8-review'] }], ...extra });
  const installed = await run('install');
  assert.deepEqual(installed.errors, []);
  assert.equal(installed.menus[0].items.find(item => item.client === 'agy').description, '0 enabled · 6 not installed', 'each CLI shows its packages');
  assert.deepEqual(installed.menus[1].items.map(item => item.action), ['install'], 'only actions with packages to change are offered');
  assert.deepEqual(installed.menus[1].items.map(item => [item.label, item.description]), [['$(cloud-download) Install / Update', '6 to install or update']], 'an icon and the number of packages it changes');
  assert.equal(installed.menus[0].items.find(item => item.client === 'agy').label, '$(circle-large-outline) Antigravity CLI');
  assert.equal(installed.menus[1].placeholder, '0 enabled · 6 not installed');
  assert.ok(installed.menus[2].many && installed.menus[2].items.every(item => item.picked), 'every package starts selected');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(file))), ['coagent8-review']);
  assert.deepEqual(installed.registrations, [], 'skill management never changes MCP registration');
  const config = fs.readFileSync(path.join(home, '.coagent8/config.json'));
  const state = fs.readFileSync(path.join(home, '.coagent8/setup.json'));
  for (const steps of [[], [{ client: 'agy' }], [{ client: 'agy' }, { action: 'disable' }]]) {
    const cancelled = await runExtension({ ...options, steps });
    assert.deepEqual(cancelled.errors, []);
    assert.deepEqual(fs.readFileSync(path.join(home, '.coagent8/config.json')), config);
    assert.deepEqual(fs.readFileSync(path.join(home, '.coagent8/setup.json')), state);
  }
  const disabled = await run('disable');
  assert.deepEqual(disabled.errors, []);
  assert.deepEqual(disabled.menus[2].items.map(item => item.name), ['coagent8-review'], 'only packages the action changes are listed');
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(archived), true);
  assert.deepEqual(disabled.menus[1].items.map(item => item.label), ['$(cloud-download) Install / Update', '$(eye-closed) Disable', '$(trash) Uninstall']);
  assert.equal(disabled.menus[0].items.find(item => item.client === 'agy').label, '$(pass-filled) Antigravity CLI');
  const enabled = await run('enable');
  assert.equal(enabled.menus[1].placeholder, '0 enabled · 1 disabled · 5 not installed');
  assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(archived), false);
  await run('uninstall');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.coagent8/config.json'))).backends.agy.skills, { installed: [], disabled: [] });
});
test('Back in Manage Skills returns one step: packages to actions, actions to the list of CLIs', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-skills-back-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await runExtension({ home, skillProfile: true, command: 'coagent8.manageSkills',
    steps: [{ client: 'agy' }, { button: 'Back' }, { client: 'codex' }, { action: 'install' }, { button: 'Back' }] });
  assert.deepEqual(result.menus.map(menu => menu.title), ['Manage Skills', 'Antigravity CLI Skills', 'Manage Skills', 'Codex CLI Skills', 'Install / Update: Codex CLI Skills', 'Codex CLI Skills']);
  assert.deepEqual(result.menus.map(menu => menu.buttons.length), [0, 1, 0, 1, 1, 1], 'every step after the list of CLIs has Back');
  assert.deepEqual(result.menus.map(menu => menu.step), ['1/3', '2/3', '1/3', '2/3', '3/3', '2/3'], 'the title counts the steps');
  assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(path.join(home, '.coagent8/config.json')), false, 'going back changes nothing');
});
test('Manage Skills from a CLI menu manages that CLI without asking for it again; Back returns to the CLI menu', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-menu-skills-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const back = await runExtension({ home, skillProfile: true, steps: [{ client: 'agy' }, { action: 'skills' }, { button: 'Back' }] });
  assert.deepEqual(back.menus.map(menu => menu.title.replace(/:.*/, '')), ['Manage Coding CLIs', 'Antigravity CLI', 'Antigravity CLI Skills', 'Antigravity CLI']);
  assert.equal(back.menus[2].step, '1/2', 'from a CLI menu the CLI is already chosen');
  const installed = await runExtension({ home, skillProfile: true, steps: [{ client: 'agy' }, { action: 'skills' }, { action: 'install' }, { names: ['coagent8-review'] }] });
  assert.deepEqual(installed.errors, []);
  assert.ok(fs.existsSync(path.join(home, '.gemini/config/skills/coagent8-review/SKILL.md')));
  assert.deepEqual(installed.menus.map(menu => menu.title.replace(/:.*/, '')), ['Manage Coding CLIs', 'Antigravity CLI', 'Antigravity CLI Skills', 'Install / Update', 'Antigravity CLI'], 'the CLI menu reopens after the change');
});

test('Manage Model Approvals lists price rules and backends, then models by price, and writes one rule per model to config.json', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-approvals-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const command = 'coagent8.manageModelApprovals';
  const allowed = await runExtension({ home, command, steps: [{ label: /Codex CLI$/ }, { label: /gpt-6-astra$/ }, { label: '$(pass-filled) Allow' }] });
  assert.deepEqual(allowed.errors, []);
  const [list, models, rule, again] = allowed.menus;
  assert.deepEqual([list.title, list.step, list.placeholder], ['Manage Model Approvals', '1/3', 'Rules apply to every client that runs CoAgent8']);
  assert.deepEqual(list.items.map(item => item.separator ? `-- ${item.label}` : [item.label, item.description]), [
    '-- Price rules',
    ['$(symbol-number) Ask Above Price', '20 USD per million output tokens'],
    ['$(symbol-number) Ask Above Default Price', '2× the backend\'s default model'],
    '-- Models',
    ['$(server) Codex CLI', '3 models · 2 ask'],
    ['$(server) Antigravity CLI', '1 model'],
  ], 'price rules first, then each backend that lists models with its counts');
  assert.deepEqual([models.title, models.step, models.buttons.includes('Back')], ['Codex CLI Models', '2/3', true]);
  assert.deepEqual(models.items.map(item => [item.label, item.description]), [
    ['$(question) gpt-7-nova', 'price unknown · asks: price unknown'],
    ['$(question) gpt-6-astra', '50 USD · asks: above price'],
    ['$(circle-large-outline) gpt-6-luna', '0.5 USD · default · runs without asking'],
  ], 'an unknown price first, then the most expensive');
  assert.deepEqual([rule.title, rule.step], ['gpt-6-astra', '3/3']);
  assert.deepEqual(rule.items.map(item => item.label), ['$(pass-filled) Allow', '$(question) Ask Every Time', '$(circle-slash) Deny', '$(law) Price Rules']);
  assert.equal(rule.items[3].description, 'current · Asks only when the price rules say so', 'the rule in force is marked');
  assert.deepEqual(allowed.config.governance.models, { allow: ['gpt-6-astra'], ask: [], deny: [] });
  assert.equal(again.title, 'Codex CLI Models', 'the list of models reopens, read again');
  assert.equal(again.items.find(item => item.label.endsWith('gpt-6-astra')).description, '50 USD · allow');
  assert.deepEqual(allowed.statusMessages, ['CoAgent8: gpt-6-astra · allow']);
  assert.ok(allowed.modelRuns.every(run => JSON.stringify(run.args) === '["models","--json"]' && run.config === path.join(home, '.coagent8/config.json')), 'the bundled runtime reads the file the server uses');

  // A new rule replaces the earlier one; Price Rules removes the model from every list.
  const denied = await runExtension({ home, command, steps: [{ label: /Codex CLI$/ }, { label: /gpt-6-astra$/ }, { label: '$(circle-slash) Deny' }] });
  assert.deepEqual(denied.config.governance.models, { allow: [], ask: [], deny: ['gpt-6-astra'] });
  assert.equal(denied.menus[2].items[0].description, 'current · Runs without asking');
  assert.equal(denied.menus[3].items.find(item => item.label.endsWith('gpt-6-astra')).label, '$(circle-slash) gpt-6-astra');
  const priced = await runExtension({ home, command, steps: [{ label: /Codex CLI$/ }, { label: /gpt-6-astra$/ }, { label: '$(law) Price Rules' }] });
  assert.deepEqual(priced.config.governance.models, { allow: [], ask: [], deny: [] });

  // Choosing the rule in force, Back or Escape writes nothing.
  const before = fs.readFileSync(path.join(home, '.coagent8/config.json'));
  for (const steps of [[], [{ label: /Codex CLI$/ }, { button: 'Back' }], [{ label: /Codex CLI$/ }, { label: /gpt-6-luna$/ }, { label: '$(law) Price Rules' }], [{ label: /Codex CLI$/ }, { label: /gpt-6-luna$/ }, { button: 'Back' }]]) {
    const unchanged = await runExtension({ home, command, steps });
    assert.deepEqual(unchanged.errors, []);
    assert.deepEqual(fs.readFileSync(path.join(home, '.coagent8/config.json')), before);
  }
  const back = await runExtension({ home, command, steps: [{ label: /Codex CLI$/ }, { button: 'Back' }] });
  assert.deepEqual(back.menus.map(menu => menu.title), ['Manage Model Approvals', 'Codex CLI Models', 'Manage Model Approvals'], 'Back returns one step');

  // A rule on the variant a default model runs as is the one the menu changes.
  fs.writeFileSync(path.join(home, '.coagent8/config.json'), JSON.stringify({ governance: { models: { allow: ['gemini-3.8-flash-low'], ask: [], deny: [] } } }));
  const variant = await runExtension({ home, command, steps: [{ label: /Antigravity CLI$/ }, { label: /gemini-3.8-flash$/ }, { label: '$(law) Price Rules' }] });
  assert.deepEqual(variant.errors, []);
  assert.equal(variant.menus[2].items[0].description, 'current · Runs without asking', 'the rule on the variant is shown as the rule in force');
  assert.deepEqual(variant.config.governance.models, { allow: [], ask: [], deny: [] }, 'Price Rules removes the rule that decided it');
  assert.deepEqual(variant.statusMessages, ['CoAgent8: gemini-3.8-flash-low · price rules']);
});
test('Manage Model Approvals opens in a multi-root window, where setup asks for one workspace', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-approvals-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const roots = await runExtension({ home, command: 'coagent8.manageModelApprovals', workspaceFolders: [path.join(home, 'one'), path.join(home, 'two')] });
  assert.deepEqual(roots.errors, []);
  assert.deepEqual(roots.menus[0].items.filter(item => !item.separator).map(item => item.label), ['$(symbol-number) Ask Above Price', '$(symbol-number) Ask Above Default Price', '$(server) Codex CLI', '$(server) Antigravity CLI']);
  assert.equal(roots.modelRuns.length, 1, 'the model report is read');
});
test('Manage Model Approvals edits the price rules: an empty price turns that rule off, invalid values are refused', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-price-rules-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const command = 'coagent8.manageModelApprovals';
  const off = await runExtension({ home, command, steps: [{ label: /Ask Above Price$/ }], inputs: [''] });
  assert.deepEqual(off.errors, []);
  assert.deepEqual(off.inputBoxes, [{ title: 'Ask Above Price', value: '20', valid: true }]);
  assert.equal(off.config.governance.askAbovePrice, null);
  assert.equal(off.menus[1].items.find(item => item.label.endsWith('Ask Above Price')).description, 'off', 'the list reopens with the new value');
  assert.equal(off.menus[1].items.find(item => item.label.endsWith('Codex CLI')).description, '3 models · 1 ask', 'only the unknown price still asks');
  const multiplier = await runExtension({ home, command, steps: [{ label: /Ask Above Default Price$/ }], inputs: ['3.5'] });
  assert.equal(multiplier.config.governance.priceMultiplier, 3.5);
  const invalid = await runExtension({ home, command, steps: [{ label: /Ask Above Default Price$/ }, { label: /Ask Above Price$/ }], inputs: ['1', '-2'] });
  assert.deepEqual(invalid.inputBoxes.map(box => box.valid), [false, false], 'a multiplier of 1 or a negative price is refused');
  assert.deepEqual([invalid.config.governance.priceMultiplier, invalid.config.governance.askAbovePrice], [3.5, null], 'and changes nothing');
  const cancelled = await runExtension({ home, command, steps: [{ label: /Ask Above Price$/ }], inputs: [] });
  assert.equal(cancelled.config.governance.askAbovePrice, null, 'a cancelled input changes nothing');
});

test('Uninstall VS Code Extension opens the extension page, where VS Code removes and restarts it', async () => {
  const codex = path.join(path.resolve('vendor', 'openai.chatgpt'), 'bin', 'codex.exe');
  const notOffered = await runExtension({ commands: { codex }, vendorExtensions: ['openai.chatgpt'], steps: [{ client: 'codex' }] });
  assert.ok(!actionsOf(notOffered.menus[1]).includes('uninstallExtension'), 'an extension the user installed is never offered');
  const options = { commands: { codex }, vendorExtensions: ['openai.chatgpt'], installs: { installedExtensions: ['openai.chatgpt'] }, registrations: { codex: 'owned' } };
  const steps = () => [{ client: 'codex' }, { action: 'uninstallExtension' }];
  const shown = await runExtension({ ...options, steps: steps() });
  // The page, not a search by ID (FEEDBACK-060b): its Uninstall and Restart Extensions apply the removal to every running extension.
  assert.deepEqual(shown.requests, [['extension.open', 'openai.chatgpt']], 'the native Uninstall and Restart Extensions apply the removal to every running extension');
  assert.deepEqual([shown.warnings, shown.notifications], [[], []], 'no dialog or notice of its own');
  assert.equal(shown.menus.length, 2, 'the menu closes on the Extensions view');
  assert.deepEqual(shown.state, { welcomed: true, removingExtensions: ['openai.chatgpt'] });
  assert.deepEqual(shown.installs, { installedExtensions: ['openai.chatgpt'] }, 'nothing is recorded as removed before VS Code removes it');
  const finished = await runExtension({ ...options, steps: steps(), nativeRemoval: ['openai.chatgpt'] });
  assert.equal(finished.installs, undefined, 'the removed extension leaves the record');
  assert.deepEqual(finished.state, { welcomed: true });
  assert.deepEqual(finished.cleanupCalls, [], 'the chat entry stays; it works again with another installation');
});
test('a removal finished while VS Code restarts its extensions moves a selection of the removed copy to the other installation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-uninstall-switch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ backends: { codex: { executable: 'vscode-extension' } } }));
  await runExtension({ configPath: file, vendorExtensions: ['openai.chatgpt'], installs: { installedExtensions: ['openai.chatgpt'] },
    steps: [{ client: 'codex' }, { action: 'uninstallExtension' }], nativeRemoval: ['openai.chatgpt'] });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backends.codex.executable, path.resolve('fixture-codex'));
});
test('at the next start a removed Antigravity extension is finished, deleting the agy it downloaded; a kept extension is forgotten', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agy = path.join(home, '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  fs.mkdirSync(path.dirname(agy), { recursive: true });
  fs.writeFileSync(agy, 'fixture');
  fs.writeFileSync(path.join(path.dirname(agy), 'other'), 'kept');
  const removed = await runExtension({ home, activationOnly: true, awaitState: true, storedState: { welcomed: true, removingExtensions: ['google.google-antigravity'] }, installs: { installedExtensions: ['google.google-antigravity'] } });
  assert.equal(fs.existsSync(agy), false);
  assert.ok(fs.existsSync(path.join(path.dirname(agy), 'other')), 'only the downloaded agy is deleted');
  assert.equal(removed.installs, undefined);
  assert.deepEqual(removed.state, { welcomed: true });
  fs.writeFileSync(agy, 'fixture');
  const kept = await runExtension({ home, activationOnly: true, awaitState: true, vendorExtensions: ['google.google-antigravity'], storedState: { welcomed: true, removingExtensions: ['google.google-antigravity'] }, installs: { installedExtensions: ['google.google-antigravity'] } });
  assert.ok(fs.existsSync(agy), 'an extension still installed after a start was kept');
  assert.deepEqual(kept.installs, { installedExtensions: ['google.google-antigravity'] });
  assert.deepEqual(kept.state, { welcomed: true });
  const roots = await runExtension({ home, activationOnly: true, awaitState: true, workspaceFolders: [path.join(home, 'one'), path.join(home, 'two')], storedState: { welcomed: true, removingExtensions: ['google.google-antigravity'] }, installs: { installedExtensions: ['google.google-antigravity'] } });
  assert.deepEqual(roots.errors, [], 'a multi-root window finishes the removal too');
  assert.equal(fs.existsSync(agy), false);
  assert.deepEqual(roots.state, { welcomed: true });
});
test('Uninstall Standalone CLI inserts reviewed removal commands and leaves the record once the CLI is gone', async t => {
  const notOffered = await runExtension({ steps: [{ client: 'claude' }] });
  assert.ok(!actionsOf(notOffered.menus[1]).includes('uninstallStandalone'), 'a CLI the user installed is never offered');
  const steps = () => [{ client: 'claude' }, { action: 'uninstallStandalone' }];
  const options = { installs: { installedClis: ['claude'] } };
  const declined = await runExtension({ ...options, steps: steps() });
  assert.deepEqual(declined.warnings, ['Remove Claude Code CLI?']);
  assert.equal(declined.terminals.length, 0);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-remove-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ backends: { claude: { executable: path.resolve('fixture-claude') } } }));
  const accepted = await runExtension({ ...options, configPath: file, steps: steps(), action: ['Remove', 'Check Now'],
    extraInstallations: { claude: [{ kind: 'vscode-extension', executable: 'vscode-extension', file: path.resolve('vendor', 'anthropic.claude-code', 'claude.exe') }] } });
  assert.match(accepted.warningDetails[0], /^The removal commands are inserted in a terminal; press Enter there to run them\. They remove .*\. If CoAgent8 uses this installation, it then uses another one or none\./);
  assert.equal(accepted.terminals[0].options.name, 'Remove Claude Code CLI');
  assert.equal(accepted.terminals[0].execute, false, 'the user reviews and runs the commands');
  // The files of Claude Code's uninstall documentation, then the installer folders left empty.
  if (process.platform === 'win32') {
    assert.ok(accepted.terminals[0].command.startsWith(String.raw`Remove-Item -LiteralPath "$env:USERPROFILE\.local\bin\claude.exe", "$env:USERPROFILE\.local\share\claude" -Recurse -Force`));
    assert.ok(accepted.terminals[0].command.includes(String.raw`'HKCU:\Environment'`), 'and their user PATH entries');
  } else assert.equal(accepted.terminals[0].command, 'rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude');
  assert.equal(accepted.installs, undefined, 'the removed CLI leaves the record');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).backends.claude.executable, 'vscode-extension', 'the removed path does not stay selected');
  assert.match(accepted.menus[2].title, /^Claude Code CLI: Not installed/);
  const notRun = await runExtension({ ...options, steps: steps(), action: ['Remove', 'Check Now'], removalRuns: false });
  assert.match(notRun.warnings.at(-1), /^Claude Code CLI is still installed\./);
  assert.deepEqual(notRun.installs, { installedClis: ['claude'] });
});
test('the Windows removal commands delete the installer link, not its target, and only the PATH entries of folders they emptied', { skip: process.platform !== 'win32' && 'PowerShell and junctions are Windows-specific' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-remove-'));
  const profile = path.join(root, 'profile'), local = path.join(root, 'local');
  // A registry key of its own stands in for HKCU\Environment; the user's PATH is never read or written.
  const key = `HKCU:\\Software\\CoAgent8Test\\${require('node:crypto').randomUUID()}`;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = script => require('node:child_process').spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, USERPROFILE: profile, LOCALAPPDATA: local }, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  t.after(() => {
    run(`Remove-Item -LiteralPath '${key}' -Recurse -Force -ErrorAction SilentlyContinue; `
      + `if (-not (Get-ChildItem -LiteralPath '${path.win32.dirname(key)}' -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath '${path.win32.dirname(key)}' -Force -ErrorAction SilentlyContinue }`);
    fs.rmSync(root, { recursive: true, force: true });
  });
  // The official installers' layout: agy behind a junction, Claude Code in ~/.local.
  const write = (file, text = 'fixture') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write(path.join(profile, '.gemini', 'bin', 'agy.exe'));
  write(path.join(profile, '.gemini', 'bin', 'kept.txt'));
  fs.mkdirSync(path.join(local, 'agy'), { recursive: true });
  fs.symlinkSync(path.join(profile, '.gemini', 'bin'), path.join(local, 'agy', 'bin'), 'junction');
  write(path.join(profile, '.local', 'bin', 'claude.exe'));
  write(path.join(profile, '.local', 'share', 'claude', 'versions', '1.0.0'));
  const entries = [path.join(local, 'agy', 'bin'), path.join(profile, '.local', 'bin'), path.join(profile, '.gemini', 'bin'), 'C:\\Kept', '%SystemRoot%\\kept'];
  const created = run(`New-Item -Path '${key}' -Force | Out-Null; New-ItemProperty -LiteralPath '${key}' -Name Path -PropertyType ExpandString -Value '${entries.join(';')}' | Out-Null`);
  assert.equal(created.status, 0, created.stderr || String(created.error));
  for (const client of ['claude', 'agy']) {
    const result = await runExtension({ installs: { installedClis: [client] }, steps: [{ client }, { action: 'uninstallStandalone' }], action: 'Remove' });
    const command = result.terminals[0].command;
    assert.equal(command.split(String.raw`'HKCU:\Environment'`).length, 3, 'the registry key appears in the read and the write');
    const removal = run(command.split(String.raw`'HKCU:\Environment'`).join(`'${key}'`));
    assert.equal(removal.status, 0, removal.stderr || String(removal.error));
  }
  assert.equal(fs.existsSync(path.join(local, 'agy')), false, 'the junction and its emptied parent are gone');
  assert.equal(fs.existsSync(path.join(profile, '.gemini', 'bin', 'agy.exe')), false);
  assert.ok(fs.existsSync(path.join(profile, '.gemini', 'bin', 'kept.txt')), 'the junction target keeps its other files');
  assert.equal(fs.existsSync(path.join(profile, '.local', 'bin')), false);
  assert.equal(fs.existsSync(path.join(profile, '.local', 'share')), false);
  const after = run(`$k = Get-Item -LiteralPath '${key}'; $k.GetValueKind('Path'); $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')`);
  assert.deepEqual(after.stdout.trim().split(/\r?\n/), ['ExpandString', [path.join(profile, '.gemini', 'bin'), 'C:\\Kept', '%SystemRoot%\\kept'].join(';')],
    'entries of removed folders go; the rest, its order, type and unexpanded variables stay');
});

test('the profile mcp.json entry starts the bundled server, follows configuration and build identity; the provider is the fallback', async t => {
  const errors = [];
  let provider, providerId, configurationListener, extensionListener, nodePath = 'node', configPath = '';
  const inspected = {};
  const notices = [];
  let workspaceFolders;
  let extensionPath;
  let changes = 0, disposed = 0;
  const disposable = () => ({ dispose() { disposed++; } });
  const vscode = {
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    env: { remoteName: 'isolated-test' },
    window: { showErrorMessage(message) { errors.push(message); }, async showInformationMessage(message) { notices.push(message); } },
    extensions: {
      getExtension(id) { return id === 'openai.chatgpt' && extensionPath ? { extensionPath, extensionUri: { scheme: 'file' } } : undefined; },
      // The provider and the removal follow-up both listen; a change reaches every listener.
      onDidChange(listener) { const previous = extensionListener; extensionListener = () => Promise.all([previous?.(), listener()]); return disposable(); },
    },
    commands: { registerCommand() { return disposable(); } },
    EventEmitter: class {
      event = () => disposable();
      fire() { changes++; }
      dispose() { disposed++; }
    },
    workspace: {
      get workspaceFolders() { return workspaceFolders; },
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
  vm.runInNewContext(output, { module, exports: module.exports, process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, require(name) {
    return name === 'vscode' ? vscode : require(name);
  } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension path with spaces '));
  const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = path.join(root, 'home');
  t.after(() => {
    for (const [key, value] of Object.entries(savedHome)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/index.cjs'), 'fixture bundle');
  const storage = path.join(root, 'User/globalStorage/okidev.coagent8-mcp');
  const workspaceState = new Map();
  const context = { subscriptions: [], globalStorageUri: { fsPath: storage }, extensionPath: root, globalState: { get() { return undefined; } },
    workspaceState: { get(key) { return workspaceState.get(key); }, async update(key, value) { workspaceState.set(key, value); } }, asAbsolutePath(relative) { return path.join(root, relative); } };
  await module.exports.activate(context);
  const mcpFile = path.join(root, 'User/mcp.json');
  // VS Code lists only mcp.json entries as installed MCP servers.
  const entry = () => JSON.parse(fs.readFileSync(mcpFile, 'utf8')).servers.CoAgent8;
  assert.equal(providerId, require('../../extensions/vscode/package.json').contributes.mcpServerDefinitionProviders[0].id);
  assert.equal(provider.provideMcpServerDefinitions().length, 0, 'the profile entry provides the server; the provider adds no second one');
  const definition = entry();
  assert.equal(definition.type, 'stdio');
  assert.equal(definition.command, 'node');
  assert.equal(definition.args.length, 2);
  assert.deepEqual(definition.args, [definition.args[0], 'mcp'], 'the profile entry passes explicit mcp');
  assert.ok(definition.args[0].startsWith(path.join(storage, 'runtime')), 'a copy in global storage outlives the extension folder of an update');
  assert.equal(fs.readFileSync(definition.args[0], 'utf8'), 'fixture bundle');
  assert.deepEqual(JSON.parse(definition.env.coagent8_EXTENSION_PATHS), {});
  assert.equal(definition.env.coagent8_DIR, storage, 'runtime data lives in storage VS Code deletes on uninstall');
  assert.equal(definition.env.coagent8_CONFIG, path.resolve(process.env.coagent8_CONFIG || path.join(os.homedir(), '.coagent8', 'config.json')), 'the configuration file is shared with the CLI and other hosts');
  nodePath = ' C:\Program Files\nodejs\node.exe ';
  await configurationListener(affects('coagent8.nodePath'));
  assert.equal(changes, 1);
  assert.equal(entry().command, nodePath.trim());
  await configurationListener({ affectsConfiguration() { return false; } });
  assert.equal(changes, 1);
  nodePath = ' ';
  await configurationListener(affects('coagent8.nodePath'));
  assert.match(errors.at(-1), /Node.js 24\+/);
  assert.equal(entry().command, 'C:\Program Files\nodejs\node.exe', 'an invalid setting leaves the working entry');
  nodePath = 'node';
  extensionPath = path.join(root, 'custom extension root', 'openai-current');
  await extensionListener();
  assert.equal(JSON.parse(entry().env.coagent8_EXTENSION_PATHS).codex, extensionPath);
  extensionPath = undefined;
  await extensionListener();
  assert.deepEqual(JSON.parse(entry().env.coagent8_EXTENSION_PATHS), {});
  configPath = path.join(root, 'custom configuration.json');
  await configurationListener(affects('coagent8.configPath'));
  assert.equal(entry().env.coagent8_CONFIG, configPath);
  assert.equal(require('../../extensions/vscode/package.json').contributes.configuration.properties['coagent8.configPath'].scope, 'machine');
  assert.equal(definition.env.coagent8_EDITOR_SETTINGS, '{}', 'contributed defaults leave config.json in effect');
  Object.assign(inspected, {
    'routing.allowedBackends': { defaultValue: ['codex', 'claude', 'agy'], globalValue: ['codex'], workspaceValue: ['agy'] },
    defaultBackend: { defaultValue: 'auto', workspaceValue: 'agy', workspaceFolderValue: 'agy' },
    'claude.defaultModel': { globalValue: 'opus' },
  });
  const before = changes;
  await configurationListener(affects('coagent8.routing.allowedBackends'));
  assert.equal(changes, before + 1, 'a backend, model or routing setting refreshes the server definition');
  assert.deepEqual(JSON.parse(entry().env.coagent8_EDITOR_SETTINGS),
    { 'routing.allowedBackends': ['codex'], 'claude.defaultModel': 'opus' }, 'only user values; a workspace cannot change backends or models');
  const firstCopy = entry().args[0];
  fs.writeFileSync(path.join(root, 'dist/index.cjs'), 'changed bundle, same package version');
  await extensionListener();
  assert.notEqual(entry().args[0], firstCopy, 'a replacement development VSIX starts a new copy despite unchanged SemVer');
  assert.equal(fs.existsSync(firstCopy), false);
  // A workspace that registers CoAgent8 too: the profile entry stays for the other windows, and
  // the user hears once that VS Code lists both.
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.vscode/mcp.json'), JSON.stringify({ servers: { coagent8: { command: 'node', args: ['C:/tools/coagent8/index.cjs'] } } }));
  workspaceFolders = [{ uri: { fsPath: workspace } }];
  const kept = entry();
  await configurationListener(affects('coagent8.nodePath'));
  await configurationListener(affects('coagent8.nodePath'));
  assert.deepEqual(entry(), kept);
  assert.deepEqual(notices, ["CoAgent8 is registered in this workspace's .vscode/mcp.json and in your user MCP servers, so VS Code lists it twice. Remove one of them."]);
  workspaceFolders = undefined;
  // When the entry cannot be kept, the provider still offers the server.
  fs.writeFileSync(path.join(root, 'home/.coagent8/vscode-mcp.json'), '{');
  fs.rmSync(mcpFile);
  await configurationListener(affects('coagent8.nodePath'));
  assert.match(errors.at(-1), /Malformed/);
  const [fallback] = provider.provideMcpServerDefinitions();
  assert.equal(fallback.args.length, 2);
  assert.equal(fallback.args[0], path.join(root, 'dist/index.cjs'));
  assert.equal(fallback.args[1], 'mcp');
  assert.ok(fallback.version.startsWith(require('../../package.json').version + '#'));
  fs.writeFileSync(path.join(root, 'dist/index.cjs'), 'another bundle');
  assert.notEqual(provider.provideMcpServerDefinitions()[0].version, fallback.version, 'tool metadata follows the build identity');
  context.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(disposed, 18);
});

test('remote and multi-root windows guide the user without assuming a global coagent8 CLI', async () => {
  const remote = await runExtension({ remoteName: 'ssh-remote' });
  assert.deepEqual(remote.warnings, ['CoAgent8 commands are not available in a remote window. In a terminal on the remote machine, run npx -y coagent8@next status (or setup, repair, skills, cleanup).']);
  assert.equal(remote.menus.length, 0);
  const multiRoot = await runExtension({ workspaceFolders: [path.resolve('workspace-a'), path.resolve('workspace-b')] });
  assert.deepEqual(multiRoot.errors, ['CoAgent8 setup: Open the intended workspace folder in its own window and run this command again.']);
});
