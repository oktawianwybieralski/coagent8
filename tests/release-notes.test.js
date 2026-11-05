const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { extractNotes, main } = require('../tooling/scripts/release-notes.cjs');

const root = path.resolve(__dirname, '..');
const cliff = path.join(root, 'node_modules', 'git-cliff', 'lib', 'cli', 'cli.js');

test('RELEASE-001e: the release notes need the section the release PR describes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-notes-'));
  try {
    assert.throws(() => extractNotes('## Summary\n\nA release.\n'), /no "## Release notes" section/);
    assert.throws(() => extractNotes('## Release notes\n\n  \n## Links\n'), /is empty/);
    const body = [
      '## Summary',
      '',
      'Not for testers.',
      '',
      '## Release notes',
      '',
      '### What is CoAgent8',
      '',
      'A bridge.',
      '',
      '```text',
      '## not a heading',
      '### not a subheading',
      '```',
      '',
      '## Links',
      '',
      'None',
    ].join('\r\n');
    const prBody = path.join(dir, 'body.md');
    fs.writeFileSync(prBody, body);
    fs.writeFileSync(path.join(dir, 'changelog.md'), '## Full Changelog\n\n- MCP:\n  - Bug fix:\n    - #1: Fix it (by @owner)\n');
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), 'aaa  coagent8-9.9.9.tgz\nbbb  coagent8-mcp-9.9.9.vsix\n');
    const out = path.join(dir, 'notes.md');
    main([
      '--pr-body',
      prBody,
      '--tag',
      'v9.9.9',
      '--changelog',
      path.join(dir, 'changelog.md'),
      '--sums',
      path.join(dir, 'SHA256SUMS'),
      '--repository',
      'owner/repo',
      '--sha',
      'abc123',
      '--out',
      out,
    ]);
    const notes = fs.readFileSync(out, 'utf8');
    // The section comes first, then the generated changelog, then the artifacts.
    assert.ok(notes.startsWith('## What is CoAgent8\n\nA bridge.'));
    assert.ok(notes.includes('## not a heading\n### not a subheading'), 'code fences stay as written');
    assert.ok(!notes.includes('Not for testers') && !notes.includes('None'), 'only that section is taken');
    assert.ok(notes.indexOf('## What is CoAgent8') < notes.indexOf('## Full Changelog'));
    assert.ok(notes.indexOf('## Full Changelog') < notes.indexOf('## Artifacts'));
    assert.match(notes, /```text\naaa {2}coagent8-9\.9\.9\.tgz\nbbb {2}coagent8-mcp-9\.9\.9\.vsix\n```/);
    assert.match(notes, /gh attestation verify coagent8-mcp-9\.9\.9\.vsix --repo owner\/repo/);
    assert.match(notes, /Built by the Release workflow from `abc123`\./);
    assert.throws(() => main(['--pr-body', prBody, '--tag', 'v9.9.9']), /Missing --changelog/);
    // The early workflow step only requires the section.
    main(['--check', '--pr-body', prBody]);
    fs.writeFileSync(prBody, 'No section.');
    assert.throws(() => main(['--check', '--pr-body', prBody]), /no "## Release notes" section/);
    assert.throws(() => main(['--check']), /Usage/);
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
    for (const subject of [
      'feat(vscode): add a picker (#1)',
      'fix(mcp): bound a result (#2)',
      'fix(agy): keep a session (#3)',
      'feat(cli): add a command (#4)',
      'fix(config): read a file (#5)',
    ]) {
      git('commit', '-q', '--allow-empty', '-m', subject);
    }
    // Offline: the release-notes configuration otherwise reads authors from the GitHub API.
    const render = (config, ...args) => {
      const result = spawnSync(process.execPath, [cliff, '--config', path.join(root, config), '--offline', '--strip', 'all', ...args], {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    for (const output of [
      render('tooling/changelog/cliff.toml', '--unreleased'),
      render('tooling/changelog/release-notes.toml', '--unreleased'),
    ]) {
      for (const area of ['- VS Code:', '- MCP:', '- Antigravity (agy):', '- CLI:', '- Config:'])
        assert.ok(output.includes(area), `${area} in\n${output}`);
      assert.ok(!/^- (Vscode|Mcp|Agy|Cli):/m.test(output), 'no raw scope names');
    }
    const notes = render('tooling/changelog/release-notes.toml', '--unreleased');
    assert.match(notes, /^## Full Changelog$/m);
    assert.ok(!notes.includes('<details>'), 'the release changelog is expanded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
