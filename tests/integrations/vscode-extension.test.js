const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

async function runSetupPicker({ installed = ['codex', 'claude', 'agy'], selected = ['agy'], action, remembered, command = 'coagent8.setup', failInstall = false, blocked = [] } = {}) {
  const handlers = {}, registrations = [], requests = [], errors = [], terminals = [], reports = [];
  const cleanupCalls = [];
  let selections;
  const dispose = () => {};
  const vscode = {
    env: {},
    extensions: { getExtension() {}, onDidChange() { return { dispose }; } },
    EventEmitter: class { event = () => {}; dispose() {} },
    workspace: {
      onDidChangeConfiguration() { return { dispose }; },
      getConfiguration() { return { get() { return 'node'; } }; }, workspaceFolders: [],
    },
    lm: { registerMcpServerDefinitionProvider() { return { dispose }; } },
    commands: {
      registerCommand(name, handler) { handlers[name] = handler; return { dispose }; },
      async executeCommand(...args) { requests.push(args); if (failInstall) throw new Error('fixture installation cancelled'); },
    },
    window: {
      async showQuickPick(items) {
        if (command === 'coagent8.setup') {
          assert.deepEqual(Array.from(items, item => item.label), ['Codex CLI', 'Claude Code CLI', 'Antigravity CLI']);
          for (const item of items) {
            assert.match(item.description, blocked.includes(item.client) ? /^Blocked/ : installed.includes(item.client) ? /^Available/ : /^Missing/);
            assert.equal(item.picked, remembered?.includes(item.client) ?? false);
          }
        }
        return selected === null ? undefined : items.filter(item => selected.includes(item.client));
      },
      async showInformationMessage(_message, ...actions) { return actions.includes(action) ? action : undefined; },
      async showWarningMessage(_message, _options, offered) { return action === offered ? offered : undefined; },
      createTerminal(options) {
        const terminal = { options, dispose, show() {}, sendText(command, execute) { Object.assign(this, { command, execute }); } };
        terminals.push(terminal); return terminal;
      },
      createOutputChannel() { return { dispose, appendLine(line) { reports.push(line); }, show() {} }; },
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
        contents: "export const SETUP_CLIENTS = ['codex', 'claude', 'agy']; export function resolveSetupClient() { return null; } export async function setupClients(options) { if (!options.statusOnly) globalThis.recordClients(options.clients); return globalThis.statuses; }", loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  const statuses = ['codex', 'claude', 'agy'].map(client => ({ client, installed: installed.includes(client), compatibility: installed.includes(client) ? 'supported' : 'unknown', authentication: 'authenticated', ready: installed.includes(client), registered: false, action: blocked.includes(client) ? 'blocked' : 'missing', message: 'fixture' }));
  vm.runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, statuses,
    recordClients(clients) { registrations.push(Array.from(clients)); },
    recordCleanup(apply) { cleanupCalls.push(apply); },
    require(name) { return name === 'vscode' ? vscode : require(name); },
  });
  const context = {
    subscriptions: [],
    globalState: { get(key) { return key === 'setupOffered' ? true : remembered; }, async update(key, value) { if (key === 'setupClients') selections = Array.from(value); } },
    asAbsolutePath(relative) { return path.resolve(relative); },
  };
  module.exports.activate(context);
  await handlers[command]();
  return { selections, registrations, terminals, requests, errors, reports, cleanupCalls };
}

test('CLI selection remembers full-label backend choices without authorizing external registration', async () => {
  const result = await runSetupPicker();
  assert.deepEqual(result.selections, ['agy']);
  assert.deepEqual(result.registrations, []);
});
test('missing Antigravity offers official installer without running it or registering a host', async () => {
  const result = await runSetupPicker({ installed: ['claude'], selected: ['agy'], action: 'Open Install Command' });
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
  const overridden = await runSetupPicker({ installed: ['claude'], blocked: ['codex'], selected: ['codex', 'agy'], action: 'Open Install Command' });
  assert.equal(overridden.terminals.length, 1);
  assert.match(overridden.terminals[0].options.name, /Antigravity/);
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

test('VS Code provider uses bundled server, updates Node configuration, and disposes registrations', () => {
  let provider, providerId, configurationListener, extensionListener, nodePath = 'node';
  let extensionPath;
  let changes = 0, disposed = 0;
  const disposable = () => ({ dispose() { disposed++; } });
  const vscode = {
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
  assert.deepEqual(JSON.parse(definition.env.coagent8_EXTENSION_PATHS), {});
  nodePath = ' C:\\Program Files\\nodejs\\node.exe ';
  configurationListener({ affectsConfiguration(section) { return section === 'coagent8.nodePath'; } });
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
  context.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(disposed, 8);
});
