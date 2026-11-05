// Builds the Windows job helper for packaging (WINDOWS-001d). The result lands in
// .artifacts/job-helper/win32-<arch>/, where tooling/scripts/build.cjs takes it into dist/.
//
//   node tooling/scripts/build-job-helper.cjs [--arch x64|arm64] [--target <triple>] [--verify]
//
// --target replaces the MSVC target, for a machine without the MSVC linker; such a build is for
// local use only, because releases build the MSVC targets.
//
// --verify builds twice in different target directories and fails unless both binaries are
// byte-identical, so the digest in a release can be checked by building the same commit again.

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const crate = path.join(root, 'native', 'coagent8-job');
const TARGETS = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' };

function build(target, targetDir) {
  const result = spawnSync('cargo', ['build', '--release', '--locked', '--bin', 'coagent8-job', '--target', target], {
    cwd: crate,
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo build failed for ${target} (exit code ${result.status}).`);
  return path.join(targetDir, target, 'release', 'coagent8-job.exe');
}

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function main(argv) {
  const archIndex = argv.indexOf('--arch');
  const arch = archIndex >= 0 ? argv[archIndex + 1] : process.arch;
  const targetIndex = argv.indexOf('--target');
  const target = targetIndex >= 0 ? argv[targetIndex + 1] : TARGETS[arch];
  if (!target) throw new Error(`No job helper target for architecture '${arch}'.`);
  const work = path.join(root, '.artifacts', 'job-helper-build');
  const binary = build(target, path.join(work, 'first'));
  if (argv.includes('--verify')) {
    const again = build(target, path.join(work, 'second'));
    if (sha256(binary) !== sha256(again)) throw new Error(`The ${arch} job helper build is not reproducible.`);
  }
  const output = path.join(root, '.artifacts', 'job-helper', `win32-${arch}`, 'coagent8-job.exe');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(binary, output);
  console.log(`Job helper ${arch}: ${path.relative(root, output)} (sha256 ${sha256(output)})`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
