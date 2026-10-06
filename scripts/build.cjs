const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { prepareBranding } = require('./branding.cjs');
const start = performance.now();
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
    `dist/index.cjs bundles the following third-party packages. Their license notices follow.\n\n${body}`);
}

const externalPackages = [];
const bundledPackages = new Set();
const inspectBundle = {
  name: 'coagent8:inspect-bundle',
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (output.type !== 'chunk') continue;
      externalPackages.push(...[...output.imports, ...output.dynamicImports].filter(imported => !isBuiltin(imported)));
      for (const [id, info] of Object.entries(output.modules)) {
        const owner = info.renderedLength > 0 && packageRoot(id);
        if (owner) bundledPackages.add(owner.dir);
      }
    }
  },
};

prepareBranding();
import('tsdown').then(({ build }) => build({
  config: false, cwd: root, entry: { index: 'src/index.ts' }, outDir: dist, clean: false,
  format: 'cjs', platform: 'node', target: 'node24', fixedExtension: true, hash: false,
  sourcemap: true, minify: true, dts: false, report: false, logLevel: 'warn',
  checks: { legacyCjs: false },
  // tsdown externalizes package.json dependencies by default; the runtime bundle must inline them.
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  inputOptions: { resolve: { mainFields: ['module', 'main'] } },
  outputOptions: { keepNames: true, comments: { legal: false, annotation: false, jsdoc: false } },
  plugins: [inspectBundle],
})).then(() => {
  if (externalPackages.length) {
    throw new Error(`Bundle requires external packages: ${externalPackages.join(', ')}`);
  }
  writeNotices(bundledPackages);
  fs.chmodSync(path.join(dist, 'index.cjs'), 0o755);
  console.error(`Build complete in ${Math.round(performance.now()-start)} ms (minified bundle includes SDK dependencies).`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
