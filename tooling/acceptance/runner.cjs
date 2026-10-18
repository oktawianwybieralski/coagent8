/**
 * Native acceptance test runner (ACCEPT-001a1 and ACCEPT-001a2, rows 2.16-2.17).
 *
 * @remarks
 * Installs given artifacts (tarball and VSIX) in isolation, drives the scenarios
 * N2-N4 through the installed runtime and the real backend CLIs, and produces
 * verifiable evidence JSON bound to artifact digests, host versions, and the
 * runtime version actually started. Processes run through the runtime's
 * supervisor (`runCommand`): shell-free, bounded output, owned teardown.
 * Persisted diagnostics go through the runtime's diagnostic redaction.
 */
require('tsx/cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runCommand } = require('../../src/execution/process.ts');
const { redactDiagnostic } = require('../../src/security/redaction.ts');
const {
  createIsolatedAcceptanceEnvironment,
  cleanupIsolatedEnvironment,
  searchPathOf,
} = require('./environment.cjs');
const {
  sha256File,
  readTarballPackageJson,
  readVsixPackageJson,
  createSyntheticArtifacts,
} = require('./artifacts.cjs');
const { BACKENDS, resolveBackendCommands, scenarioBackendEnv } = require('./backends.cjs');
const { runScenarios, NotRun } = require('./scenarios.cjs');

const SCHEMA_VERSION = '1.1.0';
const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
/** Budget for subprocess output quoted in evidence, in bytes. */
const DIAGNOSTIC_BYTES = 1024;

/**
 * Computes sha256 hash of a Buffer.
 */
function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Runs a command through the runtime supervisor.
 *
 * @returns The supervisor result; `ok` is true only for a completed run with exit code 0.
 */
async function runProcess(command, args, options = {}) {
  const result = await runCommand(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env,
    timeoutMs: options.timeoutMs || 30_000,
    abortSignal: options.abortSignal,
  });
  return { ...result, ok: result.status === 'completed' && result.exitCode === 0 && !result.error };
}

/**
 * Describes a failed run for evidence: outcome plus redacted, bounded output.
 */
function describeFailure(label, result) {
  const outcome = result.error
    ? `${result.error.code}: ${result.error.message}`
    : `exit code ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ''}`;
  const output = (result.stderr || result.stdout || '').trim();
  return `${label} failed (${outcome})${output ? `: ${redactDiagnostic(output, DIAGNOSTIC_BYTES)}` : ''}`;
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

function findOnSearchPath(env, names) {
  for (const dir of searchPathOf(env).split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir.replace(/^"|"$/g, ''), name);
      if (fs.statSync(full, { throwIfNoEntry: false })?.isFile()) return full;
    }
  }
  return null;
}

/**
 * Resolves the VS Code CLI executable and launch arguments.
 *
 * @remarks
 * On Windows, `code` in PATH is `code.cmd`, which cannot be spawned with
 * `shell: false`. The shim is resolved to the `Code.exe` and `cli.js` it starts,
 * with the `ELECTRON_RUN_AS_NODE=1` it sets; a shim that does not match that shape
 * is refused rather than run through a command shell.
 * @throws When no VS Code CLI is found or a Windows shim cannot be resolved.
 */
function resolveCodeCli(customCodePath, env = process.env) {
  const candidate = customCodePath || env.ACCEPTANCE_CODE_CLI || env.CODE_PATH
    || findOnSearchPath(env, process.platform === 'win32' ? ['code.cmd', 'code.exe'] : ['code']);

  if (!candidate) {
    throw new Error('VS Code CLI not found on PATH; pass --code-path.');
  }

  if (candidate.endsWith('.js') || candidate.endsWith('.cjs')) {
    return {
      command: process.execPath,
      prefixArgs: [candidate],
      extraEnv: {},
    };
  }

  if (process.platform === 'win32' && candidate.toLowerCase().endsWith('.cmd')) {
    const cmdContent = fs.readFileSync(candidate, 'utf8');
    const binDir = path.dirname(candidate);
    const codeExe = path.join(binDir, '..', 'Code.exe');
    const match = /"%~dp0([^"]*cli\.js)"/i.exec(cmdContent);
    const cliJs = match ? path.resolve(binDir, match[1]) : null;

    if (/^\s*set\s+ELECTRON_RUN_AS_NODE=1\s*$/im.test(cmdContent)
        && fs.statSync(path.resolve(codeExe), { throwIfNoEntry: false })?.isFile()
        && cliJs && fs.statSync(cliJs, { throwIfNoEntry: false })?.isFile()) {
      return {
        command: path.resolve(codeExe),
        prefixArgs: [cliJs],
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    throw new Error(`Unsupported VS Code shim ${candidate}: expected Code.exe, cli.js and ELECTRON_RUN_AS_NODE=1; pass --code-path.`);
  }

  return {
    command: candidate,
    prefixArgs: [],
    extraEnv: {},
  };
}

/**
 * Top-level keys a signed-in backend CLI rewrites in a watched file of the real home even
 * though its `HOME` and `USERPROFILE` are isolated. Observed 2026-10-18: the native Claude
 * Code 2.1.301 binary resolves the profile through the operating system and refreshes its
 * feature-flag cache timestamp in `~/.claude.json`. Accepted only with
 * `--with-backend-auth`, which shares backend state by design; any other change still fails.
 */
const BACKEND_CACHE_KEYS = { '.claude.json': ['cachedGrowthBookFeaturesAt'] };

/**
 * Returns the standard client registration file paths in a home directory.
 */
function getHomePreservationWatchlist(homeDir) {
  return [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.codex', 'config.toml'),
    path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
    path.join(homeDir, '.coagent8', 'config.json'),
    path.join(homeDir, '.coagent8', 'setup.json'),
  ];
}

/**
 * Digests of a JSON object's top-level values, to name the keys that changed without
 * persisting any value; `null` for a file that is not a JSON object.
 */
function topLevelDigests(content) {
  try {
    const parsed = JSON.parse(content.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, sha256Buffer(Buffer.from(JSON.stringify(value)))]));
  } catch {
    return null;
  }
}

/** Top-level keys whose values differ between two digests (key names only). */
function changedKeys(before, after) {
  if (!before || !after) return null;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key]).sort();
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
        keys: topLevelDigests(content),
      });
    } else {
      snapshot.set(p, { exists: false });
    }
  }
  return snapshot;
}

/**
 * Compares the watched real-home files with their snapshot.
 *
 * @param allowBackendCacheKeys - Accept changes limited to {@link BACKEND_CACHE_KEYS}.
 * @returns The accepted backend cache writes, named by file and keys.
 * @throws On any other creation, deletion or modification.
 */
function verifyHomePreservation(snapshot, allowBackendCacheKeys) {
  const backendWrites = [];
  for (const [watchedPath, preState] of snapshot.entries()) {
    const currentlyExists = fs.existsSync(watchedPath);
    if (!preState.exists) {
      if (currentlyExists) {
        throw new Error(`Home preservation violation: ${watchedPath} was created during acceptance run!`);
      }
    } else {
      if (!currentlyExists) {
        throw new Error(`Home preservation violation: ${watchedPath} was deleted during acceptance run!`);
      }
      const currentHash = sha256Buffer(fs.readFileSync(watchedPath));
      if (currentHash !== preState.hash) {
        // Key names help attribute a change, for example to a desktop client of the same
        // backend that runs beside the acceptance run; no value is recorded.
        const keys = changedKeys(preState.keys, topLevelDigests(fs.readFileSync(watchedPath)));
        const allowed = allowBackendCacheKeys ? BACKEND_CACHE_KEYS[path.basename(watchedPath)] || [] : [];
        if (keys && keys.length && keys.every(key => allowed.includes(key))) {
          backendWrites.push(`${path.basename(watchedPath)} (${keys.join(', ')})`);
          continue;
        }
        throw new Error(`Home preservation violation: ${watchedPath} was modified during acceptance run${keys ? ` (top-level keys changed: ${keys.join(', ') || 'none; formatting only'})` : ''}!`);
      }
    }
  }
  return backendWrites;
}

/**
 * Executes the acceptance run.
 *
 * @param options - Runner configuration options.
 * @returns Result object containing evidence and status.
 * @remarks Evidence keeps every observation made before a failure, and the home
 * preservation check runs whether or not an earlier step failed.
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
  const run = (command, args, runOptions) => runProcess(command, args, { ...runOptions, abortSignal: options.signal });
  const redactPaths = text => redactHome(text, [os.homedir(), realHome, isolated ? isolated.root : null]);
  const persistedError = err => redactPaths(redactDiagnostic(err));

  async function recordStep(id, name, fn) {
    const stepStart = Date.now();
    try {
      const res = await fn();
      steps.push({
        id,
        name,
        status: 'PASS',
        durationMs: Date.now() - stepStart,
        details: res && typeof res === 'object' && typeof res.details === 'string' ? res.details : undefined,
      });
      return res;
    } catch (err) {
      steps.push({
        id,
        name,
        status: 'FAIL',
        durationMs: Date.now() - stepStart,
        error: persistedError(err),
      });
      throw err;
    }
  }

  /**
   * A scenario step: a failure or a missing precondition is recorded and the next
   * scenario runs; an interrupt stops the run before the next one starts.
   */
  async function recordScenario(id, name, backend, fn) {
    if (options.signal?.aborted) throw new Error('Acceptance run interrupted.');
    const stepStart = Date.now();
    const step = { id, name, ...(backend ? { backend } : {}), package: 'npm' };
    try {
      const res = await fn();
      steps.push({ ...step, status: 'PASS', durationMs: Date.now() - stepStart, details: res && typeof res.details === 'string' ? res.details : undefined });
    } catch (err) {
      if (err instanceof NotRun) steps.push({ ...step, status: 'NOT_RUN', durationMs: Date.now() - stepStart, details: err.message });
      else steps.push({ ...step, status: 'FAIL', durationMs: Date.now() - stepStart, error: persistedError(err) });
    }
  }

  /** A run step; an interrupt stops the run before the next step starts. */
  function runStep(id, name, fn) {
    if (options.signal?.aborted) {
      throw new Error('Acceptance run interrupted.');
    }
    return recordStep(id, name, fn);
  }

  let tarballPath = options.tarball ? path.resolve(options.tarball) : null;
  let vsixPath = options.vsix ? path.resolve(options.vsix) : null;
  const artifacts = {
    tarball: { path: tarballPath ? path.basename(tarballPath) : 'missing', sha256: null, version: null },
    vsix: { path: vsixPath ? path.basename(vsixPath) : 'missing', sha256: null, version: null },
  };
  const hostData = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    vscode: null,
  };
  const runtimeData = {
    startedVersion: null,
    serverStatus: 'not_started',
    versionAgreement: false,
    bundleSha256: null,
  };
  let failure = null;

  try {
    // 1. Environment initialization
    await runStep('step_env_init', 'Initialize isolated temporary directory tree', () => {
      isolated = createIsolatedAcceptanceEnvironment({
        tempParent: options.tempParent,
        parentEnv: options.parentEnv || process.env,
      });
      return { details: 'Isolated root created' };
    });

    // 2. Artifact validation & hash calculation
    await runStep('step_artifacts', 'Locate and validate candidate artifacts', () => {
      if (isDryRun && (!tarballPath || !vsixPath)) {
        const syn = createSyntheticArtifacts(path.join(isolated.root, 'synthetic-artifacts'));
        tarballPath = syn.tarballPath;
        vsixPath = syn.vsixPath;
      } else if (!tarballPath || !vsixPath) {
        // Look for existing packaged artifacts in repo root .artifacts
        const pkgArtifacts = path.join(repoRoot, '.artifacts', 'package');
        const rootArtifacts = path.join(repoRoot, '.artifacts');

        if (!tarballPath && fs.existsSync(pkgArtifacts)) {
          const files = fs.readdirSync(pkgArtifacts).filter(f => f.endsWith('.tgz')).sort().reverse();
          if (files.length) tarballPath = path.join(pkgArtifacts, files[0]);
        }
        if (!vsixPath && fs.existsSync(rootArtifacts)) {
          const files = fs.readdirSync(rootArtifacts).filter(f => f.endsWith('.vsix')).sort().reverse();
          if (files.length) vsixPath = path.join(rootArtifacts, files[0]);
        }
      }

      if (!tarballPath || !fs.existsSync(tarballPath)) {
        throw new Error(`Tarball artifact not found: ${tarballPath || 'unspecified'}`);
      }
      if (!vsixPath || !fs.existsSync(vsixPath)) {
        throw new Error(`VSIX artifact not found: ${vsixPath || 'unspecified'}`);
      }

      artifacts.tarball.path = path.basename(tarballPath);
      artifacts.vsix.path = path.basename(vsixPath);
      artifacts.tarball.sha256 = sha256File(tarballPath);
      artifacts.tarball.version = readTarballPackageJson(tarballPath).version;
      artifacts.vsix.sha256 = sha256File(vsixPath);
      artifacts.vsix.version = readVsixPackageJson(vsixPath).version;
      return { details: 'Digests and manifest versions recorded' };
    });

    // 3. Host probe
    await runStep('step_host_probe', 'Probe Node, OS, and VS Code versions', async () => {
      if (isDryRun) {
        return { details: 'VS Code version not probed in dry run' };
      }
      const codeCli = resolveCodeCli(options.codePath, isolated.childEnv);
      const codeProbe = await run(codeCli.command, [
        ...codeCli.prefixArgs,
        '--user-data-dir', isolated.vscodeUserData,
        '--extensions-dir', isolated.vscodeExtensions,
        '--version',
      ], {
        env: { ...isolated.childEnv, ...codeCli.extraEnv },
        timeoutMs: 10_000,
      });
      if (!codeProbe.ok) {
        throw new Error(describeFailure('VS Code version probe', codeProbe));
      }
      const version = codeProbe.stdout.trim().split(/\r?\n/)[0];
      if (!version) {
        throw new Error('VS Code version probe printed no version.');
      }
      hostData.vscode = version;
      return { details: `VS Code ${version}` };
    });

    // 4. Tarball isolated installation
    await runStep('step_tarball_install', 'Install tarball in clean isolated npm prefix', async () => {
      const installCwd = isolated.npmPrefix;
      const initRes = await run(process.execPath, [npm, 'init', '--yes'], {
        cwd: installCwd,
        env: isolated.childEnv,
      });
      if (!initRes.ok) {
        throw new Error(describeFailure('npm init in isolated prefix', initRes));
      }

      const installRes = await run(process.execPath, [
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
      if (!installRes.ok) {
        throw new Error(describeFailure(`npm install of ${path.basename(tarballPath)}`, installRes));
      }

      const installedPkgJson = path.join(installCwd, 'node_modules', 'coagent8', 'package.json');
      if (!fs.existsSync(installedPkgJson)) {
        throw new Error('Installed package.json missing in isolated prefix.');
      }
      return { details: 'Tarball installed cleanly in isolated prefix' };
    });

    // 5. VSIX installation / verification
    await runStep('step_vsix_install', 'Verify or install VSIX in isolated environment', async () => {
      if (isDryRun) {
        // In dry run, verify package manifest and integrity without launching GUI
        const vsixManifest = readVsixPackageJson(vsixPath);
        return { details: `VSIX verified without installation in dry run: ${vsixManifest.name}@${vsixManifest.version}` };
      }

      // Native mode: install extension using explicit directories
      const codeCli = resolveCodeCli(options.codePath, isolated.childEnv);
      const installRes = await run(codeCli.command, [
        ...codeCli.prefixArgs,
        '--user-data-dir', isolated.vscodeUserData,
        '--extensions-dir', isolated.vscodeExtensions,
        '--install-extension', vsixPath,
      ], {
        env: { ...isolated.childEnv, ...codeCli.extraEnv },
        timeoutMs: 60_000,
      });
      if (!installRes.ok) {
        throw new Error(describeFailure('VS Code extension installation', installRes));
      }
      return { details: `VSIX installed into ${path.basename(isolated.vscodeExtensions)}` };
    });

    // 6. Runtime probe
    await runStep('step_runtime_probe', 'Start installed runtime and verify doctor server_version', async () => {
      const installedEntry = path.join(isolated.npmPrefix, 'node_modules', 'coagent8', 'dist', 'index.cjs');
      if (!fs.existsSync(installedEntry)) {
        throw new Error(`Runtime entrypoint not found at ${installedEntry}`);
      }

      runtimeData.bundleSha256 = sha256File(installedEntry);
      const doctorRes = await run(process.execPath, [
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

      if (!doctorRes.ok) {
        throw new Error(describeFailure('doctor probe', doctorRes));
      }

      let parsedDoctor;
      try {
        parsedDoctor = JSON.parse(doctorRes.stdout);
      } catch {
        throw new Error(`Malformed doctor JSON output: ${redactDiagnostic(doctorRes.stdout, 200)}`);
      }

      runtimeData.serverStatus = typeof parsedDoctor.status === 'string'
        ? parsedDoctor.status
        : (parsedDoctor.configError ? 'degraded_config_error' : (parsedDoctor.operational ? 'operational' : 'unknown'));
      const startedVersion = parsedDoctor.server_version || null;
      runtimeData.startedVersion = startedVersion;
      if (!startedVersion) {
        throw new Error('doctor output missing server_version.');
      }

      const versionsMatch = (
        startedVersion === artifacts.tarball.version &&
        startedVersion === artifacts.vsix.version
      );

      runtimeData.versionAgreement = versionsMatch;
      if (!versionsMatch) {
        throw new Error(
          `Version mismatch: started=${startedVersion}, tarball=${artifacts.tarball.version}, vsix=${artifacts.vsix.version}`
        );
      }

      return { details: `Runtime ${startedVersion} matches both manifests` };
    });

    // 7. Scenarios N2-N4 through the installed runtime and the real backend CLIs
    if (isDryRun) {
      steps.push({ id: 'step_scenarios', name: 'Execute live scenarios N2-N4 through real CLIs', status: 'NOT_RUN', durationMs: 0, details: 'A dry run starts no backend.' });
    } else if (!options.withBackendAuth) {
      steps.push({ id: 'step_scenarios', name: 'Execute live scenarios N2-N4 through real CLIs', status: 'NOT_RUN', durationMs: 0, details: 'The real backends need their sign-in: pass --with-backend-auth.' });
    } else {
      const parentEnv = options.parentEnv || process.env;
      let commands = null;
      await runStep('step_backend_cli', 'Resolve backend CLIs in the parent context', () => {
        commands = resolveBackendCommands(parentEnv, realHome);
        return { details: (options.backends || BACKENDS).map(id => `${id}: ${commands[id].command ? 'found' : commands[id].reason}`).join('; ') };
      });
      await runScenarios({
        entry: path.join(isolated.npmPrefix, 'node_modules', 'coagent8', 'dist', 'index.cjs'),
        env: { ...isolated.childEnv, ...scenarioBackendEnv(commands, { withBackendAuth: true, parentEnv, realHome }) },
        workRoot: path.join(isolated.root, 'scenarios'),
        backends: options.backends || BACKENDS,
        models: options.models || {},
        cheapest: Boolean(options.cheapest),
        record: recordScenario,
        signal: options.signal,
      });
    }
  } catch (err) {
    failure = err;
  }

  // 8. Home preservation verification, also after a failed step
  try {
    await recordStep('step_home_preservation', 'Verify user home preservation and isolation', () => {
      const backendWrites = verifyHomePreservation(homePreSnapshot, options.withBackendAuth && !isDryRun);
      return {
        details: `Verified ${preservationWatchlist.length} real home registration paths: ${preservationWatchlist.map(p => path.basename(p)).join(', ')}; ${backendWrites.length ? `only backend cache keys changed: ${backendWrites.join('; ')}` : 'all untouched'}`,
      };
    });
  } catch (err) {
    failure = failure || err;
  }

  const hasFailures = steps.some(s => s.status === 'FAIL');
  const hasNotRun = steps.some(s => s.status === 'NOT_RUN');
  const status = failure || hasFailures ? 'FAIL' : (hasNotRun ? 'INCOMPLETE' : 'PASS');

  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    version: artifacts.tarball.version,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    status,
    mode,
    artifacts,
    host: hostData,
    runtime: runtimeData,
    steps,
    error: failure ? persistedError(failure) : undefined,
  };

  // Redact real and isolated home paths from evidence text
  const serialized = redactPaths(JSON.stringify(evidence, null, 2) + '\n');
  const keptRoot = isolated && options.keepTemp ? isolated.root : undefined;
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, serialized);
  } finally {
    if (isolated && !options.keepTemp) {
      cleanupIsolatedEnvironment(isolated);
    }
  }

  return {
    status,
    evidence: JSON.parse(serialized),
    evidencePath,
    tempRoot: keptRoot,
    error: failure ? new Error(evidence.error) : undefined,
  };
}

module.exports = {
  runAcceptance,
  snapshotWatchlist,
  verifyHomePreservation,
  redactHome,
  resolveCodeCli,
  SCHEMA_VERSION,
};
