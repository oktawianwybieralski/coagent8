const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { readHeader, main } = require('../scripts/release-notes.cjs');

const root = path.resolve(__dirname, '..');
const cliff = path.join(root, 'node_modules', 'git-cliff', 'lib', 'cli', 'cli.js');

test('RELEASE-001e: the release notes need the tester header the release PR adds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-notes-'));
  try {
    assert.throws(() => readHeader(dir, 'v9.9.9'), /docs\/releases\/v9\.9\.9\.md is missing: the release PR adds the tester header/);
    fs.mkdirSync(path.join(dir, 'docs', 'releases'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'releases', 'v9.9.9.md'), '\n  \n');
    assert.throws(() => readHeader(dir, 'v9.9.9'), /is empty/);
    fs.writeFileSync(path.join(dir, 'docs', 'releases', 'v9.9.9.md'), '## What is CoAgent8\n\nA bridge.\n');
    fs.writeFileSync(path.join(dir, 'changelog.md'), '## Full Changelog\n\n- MCP:\n  - Bug fix:\n    - #1: Fix it (by @owner)\n');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), 'aaa  coagent8-9.9.9.tgz\nbbb  coagent8-mcp-9.9.9.vsix\n');
    const out = path.join(dir, 'notes.md');
    main(['--tag', 'v9.9.9', '--changelog', path.join(dir, 'changelog.md'), '--sums', path.join(dir, 'SHA256SUMS'), '--repository', 'owner/repo', '--sha', 'abc123', '--out', out], dir);
    const notes = fs.readFileSync(out, 'utf8');
    // The header comes first, then the generated changelog, then the artifacts.
    assert.ok(notes.indexOf('## What is CoAgent8') < notes.indexOf('## Full Changelog'));
    assert.ok(notes.indexOf('## Full Changelog') < notes.indexOf('## Artifacts'));
    assert.match(notes, /```text\naaa {2}coagent8-9\.9\.9\.tgz\nbbb {2}coagent8-mcp-9\.9\.9\.vsix\n```/);
    assert.match(notes, /gh attestation verify coagent8-mcp-9\.9\.9\.vsix --repo owner\/repo/);
    assert.match(notes, /Built by the Release workflow from `abc123`\./);
    assert.throws(() => main(['--tag', 'v9.9.9'], dir), /Missing --changelog/);
    // The early workflow step only requires the header.
    main(['--check', '--tag', 'v9.9.9'], dir);
    assert.throws(() => main(['--check', '--tag', 'v0.0.0'], dir), /docs\/releases\/v0\.0\.0\.md is missing/);
    assert.throws(() => main(['--check'], dir), /Usage/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RELEASE-001e: both changelog layouts name areas as products and show the release changelog expanded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-cliff-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    for (const subject of ['feat(vscode): add a picker (#1)', 'fix(mcp): bound a result (#2)', 'fix(agy): keep a session (#3)', 'feat(cli): add a command (#4)', 'fix(config): read a file (#5)']) {
      git('commit', '-q', '--allow-empty', '-m', subject);
    }
    // Offline: the release-notes configuration otherwise reads authors from the GitHub API.
    const render = (config, ...args) => {
      const result = spawnSync(process.execPath, [cliff, '--config', path.join(root, config), '--offline', '--strip', 'all', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    for (const output of [render('cliff.toml', '--unreleased'), render('cliff.release-notes.toml', '--unreleased')]) {
      for (const area of ['- VS Code:', '- MCP:', '- Antigravity (agy):', '- CLI:', '- Config:']) assert.ok(output.includes(area), `${area} in\n${output}`);
      assert.ok(!/^- (Vscode|Mcp|Agy|Cli):/m.test(output), 'no raw scope names');
    }
    const notes = render('cliff.release-notes.toml', '--unreleased');
    assert.match(notes, /^## Full Changelog$/m);
    assert.ok(!notes.includes('<details>'), 'the release changelog is expanded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
