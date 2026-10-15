/**
 * Native acceptance test runner skeleton (ACCEPT-001a1, row 2.16).
 *
 * @remarks
 * Installs given artifacts (tarball and VSIX) in isolation and produces
 * verifiable evidence JSON bound to artifact digests, host versions, and the
 * runtime version actually started.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  createIsolatedAcceptanceEnvironment,
  cleanupIsolatedEnvironment,
} = require('./environment.cjs');
const {
  sha256File,
  readTarballPackageJson,
  readVsixPackageJson,
  createSyntheticArtifacts,
} = require('./artifacts.cjs');

const SCHEMA_VERSION = '1.0.0';
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

/**
 * Computes sha256 hash of a Buffer.
 */
function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Runs a command synchronously with process bounds, windowsHide, and timeout.
 */
function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 30_000;
  const result = cp.spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

/**
 * Computes variations of a home directory path for robust redaction across
 * forward slashes, backslashes, JSON string escaping, and Windows drive casing.
 */
function getHomePathVariants(homePath) {
  if (!homePath || typeof homePath !== 'string') return [];
  const trimmed = homePath.replace(/[/\\]+$/, '');
  const variants = new Set();
  const forward = trimmed.replace(/\\/g, '/');
  const backslash = trimmed.replace(/\//g, '\\');
  const jsonEscaped = backslash.replace(/\\/g, '\\\\');

  variants.add(forward);
  variants.add(backslash);
  variants.add(jsonEscaped);

  if (/^[a-zA-Z]:/.test(trimmed)) {
    const driveUpper = trimmed[0].toUpperCase() + trimmed.slice(1);
    const driveLower = trimmed[0].toLowerCase() + trimmed.slice(1);

    for (const d of [driveUpper, driveLower]) {
      const f = d.replace(/\\/g, '/');
      const b = d.replace(/\//g, '\\');
      variants.add(f);
      variants.add(b);
      variants.add(b.replace(/\\/g, '\\\\'));
    }
  }

  return Array.from(variants).sort((a, b) => b.length - a.length);
}

/**
 * Sanitizes and redacts home paths from output strings and serialized JSON.
 */
function redactHome(text, homes = []) {
  if (typeof text !== 'string') return text;
  let redacted = text;
  for (const home of homes) {
    if (!home) continue;
    const variants = getHomePathVariants(home);
    for (const v of variants) {
      if (v) {
        redacted = redacted.split(v).join('~');
      }
    }
  }
  return redacted;
}

/**
 * Resolves the VS Code CLI executable and launch arguments.
 *
 * @remarks
 * On Windows, `code` in PATH is usually `code.cmd`, which cannot be spawned with
 * `shell: false`. Resolves either the underlying `Code.exe` with `cli.js` and
 * `ELECTRON_RUN_AS_NODE=1`, or safely wraps `code.cmd` via `cmd.exe`.
 */
function resolveCodeCli(customCodePath, env = process.env) {
  let candidate = customCodePath || env.ACCEPTANCE_CODE_CLI || env.CODE_PATH;

  if (!candidate) {
    const searchDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
    const names = process.platform === 'win32'
      ? ['code.cmd', 'code.exe', 'code']
      : ['code'];

    for (const dir of searchDirs) {
      for (const name of names) {
        const full = path.join(dir, name);
        if (fs.existsSync(full)) {
          candidate = full;
          break;
        }
      }
      if (candidate) break;
    }
  }

  if (!candidate) {
    return {
      command: 'code',
      prefixArgs: [],
      extraEnv: {},
    };
  }

  if (candidate.endsWith('.js') || candidate.endsWith('.cjs')) {
    return {
      command: process.execPath,
      prefixArgs: [candidate],
      extraEnv: {},
    };
  }

  if (process.platform === 'win32' && candidate.toLowerCase().endsWith('.cmd')) {
    try {
      const cmdContent = fs.readFileSync(candidate, 'utf8');
      const binDir = path.dirname(candidate);
      const parentDir = path.resolve(binDir, '..');
      const codeExe = path.join(parentDir, 'Code.exe');

      let cliJs = null;
      const match = /"%~dp0([^"]*cli\.js)"/i.exec(cmdContent);
      if (match) {
        const candidateCli = path.resolve(binDir, match[1]);
        if (fs.existsSync(candidateCli)) {
          cliJs = candidateCli;
        }
      }
      if (!cliJs) {
        const standard1 = path.join(parentDir, 'resources', 'app', 'out', 'cli.js');
        if (fs.existsSync(standard1)) {
          cliJs = standard1;
        }
      }

      if (fs.existsSync(codeExe) && cliJs) {
        return {
          command: codeExe,
          prefixArgs: [cliJs],
          extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
        };
      }
    } catch {
      // Fallback
    }

    const comSpec = env.ComSpec || 'cmd.exe';
    return {
      command: comSpec,
      prefixArgs: ['/d', '/s', '/c', candidate],
      extraEnv: {},
    };
  }

  return {
    command: candidate,
    prefixArgs: [],
    extraEnv: {},
  };
}

/**
 * Returns the standard client registration file paths in a home directory.
 */
function getHomePreservationWatchlist(homeDir) {
  return [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.codex', 'config.toml'),
    path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
    path.join(homeDir, '.coagent8', 'config.json'),
  ];
}

/**
 * Snapshots existence and SHA-256 digests of paths in a watchlist.
 */
function snapshotWatchlist(paths) {
  const snapshot = new Map();
  for (const p of paths) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p);
      snapshot.set(p, {
        exists: true,
        hash: sha256Buffer(content),
        size: content.length,
      });
    } else {
      snapshot.set(p, { exists: false });
    }
  }
  return snapshot;
}

/**
 * Executes the acceptance run.
 *
 * @param options - Runner configuration options.
 * @returns Result object containing evidence and status.
 */
async function runAcceptance(options = {}) {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const isDryRun = Boolean(options.dryRun || options.mode === 'dry-run');
  const mode = isDryRun ? 'dry-run' : 'native';
  const repoRoot = path.resolve(__dirname, '../..');
  const evidencePath = options.evidencePath
    ? path.resolve(options.evidencePath)
    : path.join(repoRoot, '.artifacts', 'acceptance', 'evidence.json');

  // Pre-run snapshot of real user home registration files to prove preservation
  const realHome = (options.parentEnv && (options.parentEnv.USERPROFILE || options.parentEnv.HOME)) || os.homedir();
  const preservationWatchlist = getHomePreservationWatchlist(realHome);
  const homePreSnapshot = snapshotWatchlist(preservationWatchlist);

  let isolated = null;
  const steps = [];

  function recordStep(id, name, fn) {
    const stepStart = Date.now();
    try {
      const res = fn();
      steps.push({
        id,
        name,
        status: 'PASS',
        durationMs: Date.now() - stepStart,
        details: res && typeof res === 'object' && res.details ? res.details : undefined,
      });
      return res;
    } catch (err) {
      steps.push({
        id,
        name,
        status: 'FAIL',
        durationMs: Date.now() - stepStart,
        error: redactHome(err.message || String(err), [os.homedir(), isolated ? isolated.root : null]),
      });
      throw err;
    }
  }

  let tarballPath = options.tarball ? path.resolve(options.tarball) : null;
  let vsixPath = options.vsix ? path.resolve(options.vsix) : null;
  let syntheticCleanup = null;

  try {
    // 1. Environment initialization
    recordStep('step_env_init', 'Initialize isolated temporary directory tree', () => {
      isolated = createIsolatedAcceptanceEnvironment({
        tempRoot: options.tempRoot,
        parentEnv: options.parentEnv || process.env,
      });
      return { details: 'Isolated root created' };
    });

    // 2. Artifact validation & hash calculation
    const artifactData = recordStep('step_artifacts', 'Locate and validate candidate artifacts', () => {
      if (isDryRun && (!tarballPath || !vsixPath)) {
        const synDir = path.join(isolated.root, 'synthetic-artifacts');
        const syn = createSyntheticArtifacts(synDir);
        tarballPath = syn.tarballPath;
        vsixPath = syn.vsixPath;
        syntheticCleanup = () => fs.rmSync(synDir, { recursive: true, force: true });
      } else if (!tarballPath || !vsixPath) {
        // Look for existing packaged artifacts in repo root .artifacts
        const pkgArtifacts = path.join(repoRoot, '.artifacts', 'package');
        const rootArtifacts = path.join(repoRoot, '.artifacts');

        if (!tarballPath && fs.existsSync(pkgArtifacts)) {
          const files = fs.readdirSync(pkgArtifacts).filter(f => f.endsWith('.tgz'));
          if (files.length) tarballPath = path.join(pkgArtifacts, files[0]);
        }
        if (!vsixPath && fs.existsSync(rootArtifacts)) {
          const files = fs.readdirSync(rootArtifacts).filter(f => f.endsWith('.vsix'));
          if (files.length) vsixPath = path.join(rootArtifacts, files[0]);
        }
      }

      if (!tarballPath || !fs.existsSync(tarballPath)) {
        throw new Error(`Tarball artifact not found: ${tarballPath || 'unspecified'}`);
      }
      if (!vsixPath || !fs.existsSync(vsixPath)) {
        throw new Error(`VSIX artifact not found: ${vsixPath || 'unspecified'}`);
      }

      const tarballSha256 = sha256File(tarballPath);
      const vsixSha256 = sha256File(vsixPath);
      const tarballPkg = readTarballPackageJson(tarballPath);
      const vsixPkg = readVsixPackageJson(vsixPath);

      return {
        tarball: {
          path: path.basename(tarballPath),
          sha256: tarballSha256,
          version: tarballPkg.version,
        },
        vsix: {
          path: path.basename(vsixPath),
          sha256: vsixSha256,
          version: vsixPkg.version,
        },
      };
    });

    // 3. Host probe
    const hostData = recordStep('step_host_probe', 'Probe Node, OS, and VS Code versions', () => {
      let vscodeVersion = null;
      if (!isDryRun) {
        const codeCli = resolveCodeCli(options.codePath, isolated.childEnv);
        const codeProbe = runProcess(codeCli.command, [
          ...codeCli.prefixArgs,
          '--user-data-dir', isolated.vscodeUserData,
          '--extensions-dir', isolated.vscodeExtensions,
          '--version',
        ], {
          env: { ...isolated.childEnv, ...codeCli.extraEnv },
          timeoutMs: 10_000,
        });
        if (codeProbe.status === 0) {
          vscodeVersion = codeProbe.stdout.trim().split('\n')[0] || null;
        }
      }
      return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        vscode: vscodeVersion,
      };
    });

    // 4. Tarball isolated installation
    recordStep('step_tarball_install', 'Install tarball in clean isolated npm prefix', () => {
      const installCwd = isolated.npmPrefix;
      const initRes = runProcess(process.execPath, [npm, 'init', '--yes'], {
        cwd: installCwd,
        env: isolated.childEnv,
      });
      if (initRes.status !== 0) {
        throw new Error(`npm init failed in isolated prefix: ${initRes.stderr || initRes.stdout}`);
      }

      const installRes = runProcess(process.execPath, [
        npm,
        'install',
        '--no-audit',
        '--no-fund',
        '--offline',
        tarballPath,
      ], {
        cwd: installCwd,
        env: isolated.childEnv,
        timeoutMs: 60_000,
      });
      if (installRes.status !== 0) {
        throw new Error(`npm install failed for ${path.basename(tarballPath)}: ${installRes.stderr || installRes.stdout}`);
      }

      const installedPkgJson = path.join(installCwd, 'node_modules', 'coagent8', 'package.json');
      if (!fs.existsSync(installedPkgJson)) {
        throw new Error('Installed package.json missing in isolated prefix.');
      }
      return { details: 'Tarball installed cleanly in isolated prefix' };
    });

    // 5. VSIX installation / verification
    recordStep('step_vsix_install', 'Verify or install VSIX in isolated environment', () => {
      if (isDryRun) {
        // In dry run, verify package manifest and integrity without launching GUI
        const vsixManifest = readVsixPackageJson(vsixPath);
        return { details: `VSIX verified without GUI: ${vsixManifest.name}@${vsixManifest.version}` };
      }

      // Native mode: install extension using explicit directories
      const codeCli = resolveCodeCli(options.codePath, isolated.childEnv);
      const installRes = runProcess(codeCli.command, [
        ...codeCli.prefixArgs,
        '--user-data-dir', isolated.vscodeUserData,
        '--extensions-dir', isolated.vscodeExtensions,
        '--install-extension', vsixPath,
      ], {
        env: { ...isolated.childEnv, ...codeCli.extraEnv },
        timeoutMs: 60_000,
      });
      if (installRes.status !== 0) {
        throw new Error(`VS Code extension installation failed: ${installRes.stderr || installRes.stdout}`);
      }
      return { details: `VSIX installed into ${path.basename(isolated.vscodeExtensions)}` };
    });

    // 6. Runtime probe
    const runtimeData = recordStep('step_runtime_probe', 'Start installed runtime and verify doctor server_version', () => {
      const installedEntry = path.join(isolated.npmPrefix, 'node_modules', 'coagent8', 'dist', 'index.cjs');
      if (!fs.existsSync(installedEntry)) {
        throw new Error(`Runtime entrypoint not found at ${installedEntry}`);
      }

      const bundleSha256 = sha256File(installedEntry);
      const doctorRes = runProcess(process.execPath, [
        installedEntry,
        'doctor',
        '--json',
        '--scope',
        'health',
      ], {
        cwd: isolated.home,
        env: isolated.childEnv,
        timeoutMs: 15_000,
      });

      if (doctorRes.status !== 0) {
        throw new Error(`doctor probe failed with code ${doctorRes.status}: ${doctorRes.stderr || doctorRes.stdout}`);
      }

      let parsedDoctor;
      try {
        parsedDoctor = JSON.parse(doctorRes.stdout);
      } catch (err) {
        throw new Error(`Malformed doctor JSON output: ${doctorRes.stdout.slice(0, 200)}`);
      }

      const startedVersion = parsedDoctor.server_version || null;
      if (!startedVersion) {
        throw new Error('doctor output missing server_version.');
      }

      const versionsMatch = (
        startedVersion === artifactData.tarball.version &&
        startedVersion === artifactData.vsix.version
      );

      if (!versionsMatch) {
        throw new Error(
          `Version mismatch: started=${startedVersion}, tarball=${artifactData.tarball.version}, vsix=${artifactData.vsix.version}`
        );
      }

      const serverStatus = typeof parsedDoctor.status === 'string'
        ? parsedDoctor.status
        : (parsedDoctor.configError ? 'degraded_config_error' : (parsedDoctor.operational ? 'operational' : 'unknown'));

      return {
        startedVersion,
        serverStatus,
        versionAgreement: versionsMatch,
        bundleSha256,
      };
    });

    // 7. Scenarios N2-N4 (deferred to 2.17)
    steps.push({
      id: 'step_scenarios_n2_n4',
      name: 'Execute live scenarios N2-N4 through real CLIs',
      status: 'NOT_RUN',
      durationMs: 0,
      details: 'Deferred to ACCEPT-001a2 (row 2.17)',
    });

    // 8. Home preservation verification
    recordStep('step_home_preservation', 'Verify user home preservation and isolation', () => {
      for (const [watchedPath, preState] of homePreSnapshot.entries()) {
        const currentlyExists = fs.existsSync(watchedPath);
        if (!preState.exists) {
          if (currentlyExists) {
            throw new Error(`Home preservation violation: ${watchedPath} was created during acceptance run!`);
          }
        } else {
          if (!currentlyExists) {
            throw new Error(`Home preservation violation: ${watchedPath} was deleted during acceptance run!`);
          }
          const currentContent = fs.readFileSync(watchedPath);
          const currentHash = sha256Buffer(currentContent);
          if (currentHash !== preState.hash) {
            throw new Error(`Home preservation violation: ${watchedPath} was modified during acceptance run!`);
          }
        }
      }
      return {
        details: `Verified ${preservationWatchlist.length} real home registration paths untouched: ${preservationWatchlist.map(p => path.basename(p)).join(', ')}`,
      };
    });

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const hasFailures = steps.some(s => s.status === 'FAIL');
    const hasNotRun = steps.some(s => s.status === 'NOT_RUN');
    const overallStatus = hasFailures ? 'FAIL' : (hasNotRun ? 'INCOMPLETE' : 'PASS');

    const evidence = {
      schemaVersion: SCHEMA_VERSION,
      version: artifactData.tarball.version,
      startedAt,
      completedAt,
      durationMs,
      status: overallStatus,
      mode,
      artifacts: artifactData,
      host: hostData,
      runtime: runtimeData,
      steps,
    };

    // Redact real and isolated home paths from evidence text
    const serialized = redactHome(JSON.stringify(evidence, null, 2) + '\n', [
      os.homedir(),
      isolated.root,
    ]);

    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, serialized);

    return {
      status: overallStatus,
      evidence: JSON.parse(serialized),
      evidencePath,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const rawErrorMessage = err && err.message ? err.message : String(err);
    const redactedErrorMessage = redactHome(rawErrorMessage, [
      os.homedir(),
      isolated ? isolated.root : null,
    ]);

    const evidence = {
      schemaVersion: SCHEMA_VERSION,
      version: 'unknown',
      startedAt,
      completedAt,
      durationMs,
      status: 'FAIL',
      mode,
      artifacts: {
        tarball: { path: tarballPath ? path.basename(tarballPath) : 'missing', sha256: 'none', version: 'none' },
        vsix: { path: vsixPath ? path.basename(vsixPath) : 'missing', sha256: 'none', version: 'none' },
      },
      host: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        vscode: null,
      },
      runtime: {
        startedVersion: null,
        serverStatus: 'failed',
        versionAgreement: false,
        bundleSha256: null,
      },
      steps,
      error: redactedErrorMessage,
    };

    let serializedFail = JSON.stringify(evidence, null, 2) + '\n';
    serializedFail = redactHome(serializedFail, [
      os.homedir(),
      isolated ? isolated.root : null,
    ]);

    try {
      fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
      fs.writeFileSync(evidencePath, serializedFail);
    } catch {
      // Ignore write failure on abort
    }

    return {
      status: 'FAIL',
      evidence: JSON.parse(serializedFail),
      evidencePath,
      error: new Error(redactedErrorMessage),
    };
  } finally {
    if (syntheticCleanup) {
      try { syntheticCleanup(); } catch {}
    }
    if (isolated && !options.keepTemp) {
      cleanupIsolatedEnvironment(isolated);
    }
  }
}

module.exports = {
  runAcceptance,
  redactHome,
  resolveCodeCli,
  SCHEMA_VERSION,
};
