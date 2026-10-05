const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

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
    entryPoints: [path.resolve(__dirname, '..', 'extensions/vscode/src/extension.ts')],
    bundle: true, write: false, platform: 'node', target: 'node20', format: 'cjs', external: ['vscode'], mainFields: ['module', 'main'],
  }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, process, Buffer, require(name) {
    return name === 'vscode' ? vscode : require(name);
  } });
  const root = path.resolve('extension path with spaces');
  const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(root, 'User/globalStorage/coagent8') }, asAbsolutePath(relative) { return path.join(root, relative); } };
  module.exports.activate(context);
  assert.equal(providerId, require('../extensions/vscode/package.json').contributes.mcpServerDefinitionProviders[0].id);
  const definition = provider.provideMcpServerDefinitions()[0];
  assert.equal(definition.label, 'CoAgent');
  assert.equal(definition.command, 'node');
  assert.equal(definition.args.length, 1);
  assert.equal(definition.args[0], path.join(root, 'dist/index.cjs'));
  assert.equal(definition.version, require('../package.json').version);
  nodePath = ' C:\\Program Files\\nodejs\\node.exe ';
  configurationListener({ affectsConfiguration(section) { return section === 'coagent8.nodePath'; } });
  assert.equal(changes, 1);
  assert.equal(provider.provideMcpServerDefinitions()[0].command, nodePath.trim());
  configurationListener({ affectsConfiguration() { return false; } });
  assert.equal(changes, 1);
  nodePath = ' ';
  assert.throws(() => provider.provideMcpServerDefinitions(), /Node.js 20\+/);
  context.subscriptions.forEach(subscription => subscription.dispose());
  assert.equal(disposed, 4);
});
