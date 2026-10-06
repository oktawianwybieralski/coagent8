const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-review-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { handleReview } = require('../../src/tools/review.tool.ts');
const { saveConfig } = require('../../src/config.ts');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('review prompt names the snapshot, asks for the bounded envelope, and a matching answer passes the gate', async () => {
  const repo = path.join(tempDir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 2;\n');
  const head = git('rev-parse', '--short', 'HEAD');
  const original = adapterRegistry.gemini;
  let prompt = '';
  adapterRegistry.gemini = { id: 'gemini', name: 'fixture', probe: async () => ({ installed: true, executionSupported: true }),
    execute: async received => {
      prompt = received;
      return { status: 'completed', isError: false, truncated: false, continuationAvailable: true, nativeSessionId: '11111111-2222-3333-4444-555555555555', model: 'gemini-test',
        output: ['REVIEW: 1', `SNAPSHOT: ${head}+uncommitted`, 'COVERAGE: COMPLETE', 'VERDICT: READY', '[P3] a.ts:1', 'Problem: The constant name is short.', 'CHECKS: typecheck=NOT_RUN; tests=NOT_RUN', 'END_REVIEW'].join('\n') };
    } };
  try {
    saveConfig({ defaultBackend: 'gemini', routing: { strategy: 'fixed', allowedBackends: ['gemini'] } });
    const result = await handleReview('review', {}, repo);
    assert.ok(prompt.startsWith('Review this diff: Uncommitted working changes'), prompt.slice(0, 80));
    assert.ok(prompt.includes(`SNAPSHOT: ${head}+uncommitted\n`), 'the snapshot is given, not looked up');
    for (const line of ['REVIEW: <turn>', 'COVERAGE: COMPLETE | PARTIAL', 'VERDICT: READY | BLOCKED', 'Evidence: <at most two sentences, citing file:line>', 'Fix: <one sentence>', 'END_REVIEW', 'DIFF:']) {
      assert.ok(prompt.includes(line), line);
    }
    assert.ok(prompt.includes('+export const a = 2;'));
    assert.equal(result.structuredContent.verdict, 'READY', JSON.stringify(result.structuredContent));
  } finally {
    adapterRegistry.gemini = original;
  }
});
