const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { isBuiltin } = require('node:module');
const { prepareBranding } = require('./branding.cjs');
const start = performance.now();
prepareBranding();
esbuild.build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.cjs', bundle: true,
  platform: 'node', target: 'node20', format: 'cjs', sourcemap: true,
  minify: true, keepNames: true, metafile: true, logLevel: 'warning', mainFields: ['module', 'main'],
}).then(({ metafile }) => {
  const externalPackages = Object.values(metafile.outputs).flatMap(output => output.imports)
    .filter(imported => imported.external && !isBuiltin(imported.path));
  if (externalPackages.length) {
    throw new Error(`Bundle requires external packages: ${externalPackages.map(imported => imported.path).join(', ')}`);
  }
  fs.chmodSync(path.resolve('dist/index.cjs'), 0o755);
  console.error(`Build complete in ${Math.round(performance.now()-start)} ms (minified bundle includes SDK dependencies).`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
