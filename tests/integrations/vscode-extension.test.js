const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

async function runSetupPicker({ installed = ['codex', 'claude', 'agy'], selected = ['agy'], install = false, remembered } = {}) {
  let setupCommand, selectedClients;
  const terminals = [];
  const dispose = () => {};
  const vscode = {
    env: {},
    EventEmitter: class { event = () => {}; dispose() {} },
    workspace: {
      onDidChangeConfiguration() { return { dispose }; },
      getConfiguration() { return { get() { return 'node'; } }; },
      workspaceFolders: [],
    },
    lm: { registerMcpServerDefinitionProvider() { return { dispose }; } },
    commands: { registerCommand(name, handler) { setupCommand = handler; return { dispose }; } },
    window: {
      async showQuickPick(items) {
        assert.deepEqual(Array.from(items, item => item.label), ['Codex CLI', 'Claude Code CLI', 'Antigravity CLI']);
        for (const item of items) {
          assert.match(item.description, installed.includes(item.client) ? /^Available/ : /^Missing/);
          assert.equal(item.picked, remembered?.includes(item.client) ?? false);
        }
        return selected === null ? undefined : items.filter(item => selected.includes(item.client));
      },
      async showInformationMessage(message, action) { return install ? action : undefined; },
      createTerminal(options) {
        const terminal = { options, dispose, show() {}, sendText(command, execute) { Object.assign(this, { command, execute }); } };
        terminals.push(terminal);
        return terminal;
      },
      createOutputChannel() { return { dispose, appendLine() {}, show() {} }; },
      async showErrorMessage(message) { assert.fail(message); },
    },
  };
  const output = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../..', 'extensions/vscode/src/extension.ts')],
    bundle: true, write: false, platform: 'node', target: 'node24', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
    plugins: [{ name: 'isolated-setup', setup(build) {
      build.onLoad({ filter: /[\\/]integrations[\\/]setup\.ts$/ }, () => ({
        contents: "export const SETUP_CLIENTS = ['codex', 'claude', 'agy']; export function resolveSetupClient(client) { return globalThis.installed.includes(client) ? 'fixture' : null; } export async function setupClients(options) { globalThis.recordClients(options.clients); return []; }",
        loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, installed,
    recordClients(clients) { selectedClients = Array.from(clients); },
    require(name) { return name === 'vscode' ? vscode : require(name); },
  });
  const context = {
    subscriptions: [],
    globalState: { get(key) { return key === 'setupOffered' ? true : remembered; }, async update() {} },
    asAbsolutePath(relative) { return path.resolve(relative); },
  };
  module.exports.activate(context);
  await setupCommand();
  return { selectedClients, terminals };
}

test('setup picker displays full CLI names and retains internal client IDs', async () => {
  const { selectedClients } = await runSetupPicker();
  assert.deepEqual(selectedClients, ['agy']);
});

test('missing CLI selection offers installation without registering an absent client', async () => {
  const { selectedClients, terminals } = await runSetupPicker({ installed: ['claude'], selected: ['agy'], install: true });
  assert.equal(selectedClients, undefined);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].options.name, 'Install Antigravity CLI');
  assert.match(terminals[0].command, /https:\/\/antigravity\.google\/cli\/install\.(ps1|sh)/);
  assert.equal(terminals[0].execute, false, 'the user reviews the command and presses Enter');
  assert.equal(terminals[0].options.shellPath, process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
});

test('repair shows remembered selections and cancellation never opens an installer', async () => {
  const { selectedClients, terminals } = await runSetupPicker({ installed: ['claude'], selected: null, remembered: ['codex', 'claude'] });
  assert.equal(selectedClients, undefined);
  assert.equal(terminals.length, 0);
  const declined = await runSetupPicker({ installed: ['claude'], selected: ['codex', 'claude'], install: false });
  assert.deepEqual(declined.selectedClients, ['claude']);
  assert.equal(declined.terminals.length, 0);
});

test('VS Code provider uses bundled server, updates Node configuration, and disposes registrations', () => {
  let provider, providerId, configurationListener, nodePath = 'node';
  let changes = 0, disposed = 0;
  const disposable = () => ({ dispose() { disposed++; } });
  const vscode = {
    env: { remoteName: 'isolated-test' },
    commands: { registerCommand() { return disposable(); } },
    EventEmitter: class {
      event = () => disposable();
      fire() { changes++; }
      dispose() { disposed++; }
    },
    workspace: {
      onDidChangeConfiguration(listener) { configurationListener = listener; return disposable(); },
      getConfiguration(section) {
        assert.equal(section, 'coagent8');
        return { get(key, fallback) { assert.equal(key, 'nodePath'); return nodePath ?? fallback; } };
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
  const root = path.resolve('extension path with spaces');
  const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(root, 'User/globalStorage/coagent8') }, asAbsolutePath(relative) { return path.join(root, relative); } };
  module.exports.activate(context);
  assert.equal(providerId, require('../../extensions/vscode/package.json').contributes.mcpServerDefinitionProviders[0].id);
  const definition = provider.provideMcpServerDefinitions()[0];
  assert.equal(definition.label, 'CoAgent8');
  assert.equal(definition.command, 'node');
  assert.equal(definition.args.length, 1);
  assert.equal(definition.args[0], path.join(root, 'dist/index.cjs'));
  assert.equal(definition.version, require('../../package.json').version);
  nodePath = ' C:\\Program Files\\nodejs\\node.exe ';
  configurationListener({ affectsConfiguration(section) { return section === 'coagent8.nodePath'; } });
  assert.equal(changes, 1);
  assert.equal(provider.provideMcpServerDefinitions()[0].command, nodePath.trim());
  configurationListener({ affectsConfiguration() { return false; } });
  assert.equal(changes, 1);
  nodePath = ' ';
  assert.throws(() => provider.provideMcpServerDefinitions(), /Node.js 24\+/);
  context.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(disposed, 4);
});
