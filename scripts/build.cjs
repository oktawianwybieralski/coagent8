const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { prepareBranding } = require('./branding.cjs');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

// The bundle carries no comments. License notices of the bundled packages ship next to it instead.
function packageRoot(moduleId) {
  const normalized = moduleId.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/node_modules/');
  if (index < 0) return null;
  const segments = normalized.slice(index + '/node_modules/'.length).split('/');
  const name = segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  return { name, dir: normalized.slice(0, index) + '/node_modules/' + name };
}

function writeNotices(packageDirs) {
  const entries = [...packageDirs].map(dir => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const licenseFile = fs.readdirSync(dir).filter(name => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(name)).sort()[0];
    if (!licenseFile) throw new Error(`Bundled package ${manifest.name} has no license file.`);
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'see license text';
    return { name: manifest.name, version: manifest.version, license,
      text: fs.readFileSync(path.join(dir, licenseFile), 'utf8').replace(/\r\n/g, '\n').trim() };
  // Code-point order keeps the file byte-identical regardless of the build machine's locale.
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const rule = '='.repeat(80);
  const body = entries.map(entry => `${rule}\n${entry.name} ${entry.version} (${entry.license})\n${rule}\n\n${entry.text}\n`).join('\n');
  fs.writeFileSync(path.join(dist, 'THIRD_PARTY_NOTICES.txt'),
    `dist/index.cjs and dist/setup.cjs bundle the following third-party packages. Their license notices follow.\n\n${body}`);
}

async function buildBundles({ write = true } = {}) {
  const start = performance.now();
  if (write) {
    prepareBranding();
    fs.rmSync(dist, { recursive: true, force: true });
  }
  const externalPackages = [];
  const bundledPackages = new Set();
  const modules = {};
  const inspectBundle = {
    name: 'coagent8:inspect-bundle',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        externalPackages.push(...[...output.imports, ...output.dynamicImports].filter(imported => !isBuiltin(imported)));
        const rendered = [];
        for (const [id, info] of Object.entries(output.modules)) {
          if (info.renderedLength <= 0) continue;
          rendered.push(id.startsWith('\0') ? id : path.relative(root, id).replace(/\\/g, '/'));
          const owner = packageRoot(id);
          if (owner) bundledPackages.add(owner.dir);
        }
        modules[output.fileName] = rendered.sort();
      }
    },
  };

  const { build } = await import('tsdown');
  for (const entry of [{ index: 'src/index.ts' }, { setup: 'src/integrations/setup-cli.ts' }]) {
    await build({
      config: false, cwd: root, entry, outDir: dist, clean: false, write,
      format: 'cjs', platform: 'node', target: 'node24', fixedExtension: true, hash: false,
      sourcemap: false, minify: true, dts: false, report: false, logLevel: 'warn',
      checks: { legacyCjs: false },
      // tsdown externalizes package.json dependencies by default; the runtime bundle must inline them.
      deps: { alwaysBundle: [/.*/], onlyBundle: false },
      inputOptions: { resolve: { mainFields: ['module', 'main'] } },
      outputOptions: { keepNames: true, comments: { legal: false, annotation: false, jsdoc: false } },
      plugins: [inspectBundle],
    });
  }
  if (externalPackages.length) {
    throw new Error(`Bundle requires external packages: ${externalPackages.join(', ')}`);
  }
  if (modules['index.cjs']?.some(id => /integrations[\\/]|jsonc-parser/.test(id))) {
    throw new Error('Core bundle dist/index.cjs must not include setup integrations or jsonc-parser.');
  }
  if (!modules['setup.cjs']?.includes('src/integrations/setup-cli.ts') || !modules['setup.cjs']?.some(id => /jsonc-parser/.test(id))) {
    throw new Error('Setup bundle dist/setup.cjs must include setup-cli.ts and jsonc-parser.');
  }
  if (write) {
    writeNotices(bundledPackages);
    fs.chmodSync(path.join(dist, 'index.cjs'), 0o755);
    console.error(`Build complete in ${Math.round(performance.now() - start)} ms (minified bundle includes SDK dependencies).`);
  }
  return { modules, externalPackages, bundledPackages };
}

if (require.main === module) {
  buildBundles().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildBundles };
