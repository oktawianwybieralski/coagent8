const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// REVIEW-003: checks the user allowed run on the reviewed state before the turn, and their results decide.

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-review-checks-'));
process.env.coagent8_DIR = path.join(tempDir, 'data');
const { adapterRegistry } = require('../../src/backends/registry.ts');
const { handleReview } = require('../../src/mcp/tools/review.tool.ts');
const { saveConfig } = require('../../src/config.ts');
const { readResult } = require('../helpers/result.cjs');
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const node = JSON.stringify(process.execPath);
const PASS = `${node} -e "process.exitCode=0"`;
const FAIL = `${node} -e "console.error('broken');process.exitCode=4"`;
const WRITES = `${node} -e "require('fs').writeFileSync('made.txt','x')"`;

function repo() {
  const dir = fs.mkdtempSync(path.join(tempDir, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
  return dir;
}

function stubReviewer(checksLine) {
  const prompts = [];
  adapterRegistry.agy = {
    id: 'agy',
    name: 'fixture',
    probe: async () => ({ installed: true, executionSupported: true, config: { defaultModel: 'fixture-model' } }),
    execute: async prompt => {
      prompts.push(prompt);
      const snapshot = prompt.match(/^SNAPSHOT: (.+)$/m)?.[1] ?? 'snapshot';
      return {
        status: 'completed',
        isError: false,
        output: `REVIEW: 1\nSNAPSHOT: ${snapshot}\nCOVERAGE: COMPLETE\nVERDICT: READY\nReviewed: a.ts.\nCHECKS: ${checksLine}`,
        nativeSessionId: '11111111-2222-3333-4444-555555555555',
        model: 'fixture-model',
        truncated: false,
        continuationAvailable: true,
      };
    },
  };
  return prompts;
}

async function setup(allowedChecks) {
  await saveConfig({
    defaultBackend: 'agy',
    routing: { strategy: 'fixed', allowedBackends: ['agy'] },
    governance: { models: { allow: ['fixture-model'] } },
    allowedChecks,
  });
}

test('passing server checks replace the typecheck and tests the reviewer could not run', async () => {
  const original = adapterRegistry.agy;
  try {
    await setup([PASS]);
    const prompts = stubReviewer('typecheck=NOT_RUN; tests=NOT_RUN');
    const result = readResult(await handleReview('review', { checks: [PASS] }, repo(), null, null));
    assert.match(prompts[0], /The server ran these checks on exactly this change/);
    assert.equal(result.verdict, 'READY');
    assert.match(result.reason ?? '', /1 check passed on the server/);
    assert.doesNotMatch(result.reason ?? '', /not run/);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a failing server check blocks, whatever the reviewer reports', async () => {
  const original = adapterRegistry.agy;
  try {
    await setup([FAIL]);
    const prompts = stubReviewer('typecheck=PASS; tests=PASS');
    const result = readResult(await handleReview('review', { checks: [FAIL] }, repo(), null, null));
    assert.match(prompts[0], /broken/, 'the reviewer sees the failure');
    assert.equal(result.verdict, 'BLOCKED');
    assert.match(result.reason, /A check the server ran did not pass/);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a check outside allowedChecks is refused before it runs or any turn starts', async () => {
  const original = adapterRegistry.agy;
  try {
    await setup([]);
    const prompts = stubReviewer('typecheck=PASS; tests=PASS');
    await assert.rejects(
      handleReview('review', { checks: [PASS] }, repo(), null, null),
      err => err.code === 'POLICY_DENIED' && /allowedChecks/.test(err.message),
    );
    assert.equal(prompts.length, 0);
  } finally {
    adapterRegistry.agy = original;
  }
});

test('a check that changes the reviewed files is refused before any turn', async () => {
  const original = adapterRegistry.agy;
  try {
    await setup([WRITES]);
    const prompts = stubReviewer('typecheck=PASS; tests=PASS');
    await assert.rejects(
      handleReview('review', { checks: [WRITES] }, repo(), null, null),
      err => err.code === 'POLICY_DENIED' && /changed the reviewed files/.test(err.message),
    );
    assert.equal(prompts.length, 0);
  } finally {
    adapterRegistry.agy = original;
  }
});
