// Publishes the verified package tarball to npm (RELEASE-001a).
// Used by .github/workflows/npm-publish.yml for production releases and by CI for dry-run verification.
// Targets ./release/coagent8-<version>.tgz explicitly with leading ./ to prevent npm from interpreting
// release/<file> as a GitHub user/repo repository identifier.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

/** Resolves the npm execution command across Windows, macOS, and Linux Node distributions. */
function resolveNpmCommand(env = process.env) {
  if (env.npm_execpath && fs.existsSync(env.npm_execpath)) {
    return { command: process.execPath, argsPrefix: [env.npm_execpath] };
  }
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, argsPrefix: [candidate] };
    }
  }
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return { command: bin, argsPrefix: [] };
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

  const isPreview = version.startsWith('0.');
  const channel = options.channel || (isPreview ? 'next' : 'latest');
  const expectedPrerelease = isPreview;

  const rawPrerelease = options.prerelease !== undefined ? options.prerelease : process.env.PRERELEASE;
  if (rawPrerelease !== undefined && rawPrerelease !== '') {
    const actualPrerelease = String(rawPrerelease) === 'true';
    if (actualPrerelease !== expectedPrerelease) {
      throw new Error(`GitHub pre-release flag ${rawPrerelease} does not match version ${version} (expected ${expectedPrerelease})`);
    }
  }

  const releaseDir = options.releaseDir || './release';
  const normalizedDir = releaseDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = normalizedDir.startsWith('./') ? normalizedDir : `./${normalizedDir.replace(/^\/+/, '')}`;
  const tarballPath = `${prefix}/coagent8-${version}.tgz`;

  return {
    version,
    channel,
    isPreview,
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
  const publishTarget = plan.tarballPath.startsWith('./') ? plan.tarballPath : `./${plan.tarballPath.replace(/^\/+/, '')}`;
  const args = [...npmCmd.argsPrefix, 'publish', publishTarget, '--tag', plan.channel, '--access', 'public'];

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
      process.stdout.write(`npm publish dry-run verified for ${publishTarget}: version ${plan.version} already published on registry.\n`);
      return { status: 0, stdout: proc.stdout, stderr: proc.stderr, plan };
    }
    throw new Error(`npm publish failed (status ${proc.status}):\n${output}`);
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
  resolveNpmCommand,
  resolvePublishPlan,
  runPublishNpm,
};
