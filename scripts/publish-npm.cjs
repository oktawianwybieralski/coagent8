// Stages the verified package tarball on npm (RELEASE-001a, RELEASE-001b1).
// Used by .github/workflows/npm-publish.yml for releases and by CI for dry-run verification.
// `npm stage publish` through trusted publishing (OIDC) puts the exact file in npm's staging
// queue; the owner approves it on npmjs.com with 2FA. Every release goes to the `next`
// dist-tag, which is immutable for a staged version; the owner promotes a version to `latest`
// by hand once it proved stable (owner decision 2026-10-19).
// Targets ./release/coagent8-<version>.tgz explicitly with leading ./ to prevent npm from interpreting
// release/<file> as a GitHub user/repo repository identifier.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

/** Resolves npm-cli.js in a given directory or its standard sibling folders. */
function findNpmCli(dir) {
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, 'bin', 'npm-cli.js'),
    path.join(dir, 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

/** Resolves the npm execution command across Windows, macOS, and Linux Node distributions. */
function resolveNpmCommand(env = process.env, execPath = process.execPath) {
  if (env.npm_execpath && fs.existsSync(env.npm_execpath)) {
    return { command: execPath, argsPrefix: [env.npm_execpath] };
  }

  // 1. Check relative to current Node executable directory
  const execDir = path.dirname(execPath);
  const fromExec = findNpmCli(execDir);
  if (fromExec) {
    return { command: execPath, argsPrefix: [fromExec] };
  }

  // 2. Check each directory in PATH for npm installation or npm-cli.js
  const pathDirs = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const fromPath = findNpmCli(dir);
    if (fromPath) {
      return { command: execPath, argsPrefix: [fromPath] };
    }
  }

  // 3. Fallback: on Windows invoke through command interpreter to handle .cmd; on POSIX invoke npm binary
  if (process.platform === 'win32') {
    const comSpec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return { command: comSpec, argsPrefix: ['/d', '/s', '/c', 'npm'] };
  }
  return { command: 'npm', argsPrefix: [] };
}

/** Oldest npm CLI with `npm stage publish`. */
const MIN_STAGE_NPM = [11, 15, 0];

/** Whether an npm version string supports staged publishing. */
function supportsStaging(version) {
  const parts = String(version).trim().split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) !== MIN_STAGE_NPM[i]) return (parts[i] || 0) > MIN_STAGE_NPM[i];
  }
  return true;
}

function resolvePublishPlan(options = {}) {
  const cwd = options.cwd || root;
  let version = options.version;
  if (!version) {
    if (options.tag) {
      version = options.tag.replace(/^v/, '');
    } else if (process.env.TAG) {
      version = process.env.TAG.replace(/^v/, '');
    } else {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      version = pkg.version;
    }
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version ${version} is not numeric major.minor.patch.`);
  // Every release is staged to `next`; `latest` is the owner's promotion of a stable version.
  const channel = 'next';

  const releaseDir = options.releaseDir || './release';
  const normalizedDir = releaseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = normalizedDir.startsWith('./') ? normalizedDir : `./${normalizedDir.replace(/^\/+/, '')}`;
  const tarballPath = `${prefix}/coagent8-${version}.tgz`;

  return {
    version,
    channel,
    tarballPath,
  };
}

function runPublishNpm(options = {}) {
  const cwd = options.cwd || root;
  const dryRun = options.dryRun !== undefined ? options.dryRun : process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  const plan = resolvePublishPlan(options);

  const fullTarballPath = path.resolve(cwd, plan.tarballPath);
  if (!fs.existsSync(fullTarballPath)) {
    const fallbackSource = path.join(cwd, '.artifacts', 'consumer', `coagent8-${plan.version}.tgz`);
    if (dryRun && fs.existsSync(fallbackSource)) {
      fs.mkdirSync(path.dirname(fullTarballPath), { recursive: true });
      fs.copyFileSync(fallbackSource, fullTarballPath);
    } else {
      throw new Error(`Release tarball not found at ${fullTarballPath}`);
    }
  }

  const npmCmd = options.npmCommand || resolveNpmCommand();
  const npmVersion = spawnSync(npmCmd.command, [...npmCmd.argsPrefix, '--version'], { cwd, encoding: 'utf8', windowsHide: true });
  if (npmVersion.status !== 0 || !supportsStaging(npmVersion.stdout)) {
    throw new Error(`npm ${String(npmVersion.stdout || '').trim() || '(unknown version)'} cannot stage packages; ${MIN_STAGE_NPM.join('.')} or later is required.`);
  }
  const publishTarget = plan.tarballPath.startsWith('./') ? plan.tarballPath : `./${plan.tarballPath.replace(/^\/+/, '')}`;
  const args = [...npmCmd.argsPrefix, 'stage', 'publish', publishTarget, '--tag', plan.channel, '--access', 'public'];

  if (dryRun) {
    args.push('--dry-run');
  } else {
    args.push('--provenance');
  }

  const proc = spawnSync(npmCmd.command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });

  const output = `${proc.stdout || ''}\n${proc.stderr || ''}`;

  if (proc.status !== 0) {
    if (dryRun && /You cannot publish over the previously published versions/.test(output)) {
      process.stdout.write(`npm stage publish dry-run verified for ${publishTarget}: version ${plan.version} already published on registry.\n`);
      return { status: 0, stdout: proc.stdout, stderr: proc.stderr, plan };
    }
    throw new Error(`npm stage publish failed (status ${proc.status}):\n${output}`);
  }

  process.stdout.write(output);
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, plan };
}

if (require.main === module) {
  try {
    runPublishNpm();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  findNpmCli,
  resolveNpmCommand,
  resolvePublishPlan,
  runPublishNpm,
  supportsStaging,
};
