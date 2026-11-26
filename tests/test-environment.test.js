'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTestEnvironment } = require('./helpers/environment.cjs');

test('the test environment drops every CoAgent8 path override it inherits (#232)', () => {
  const inherited = {
    PATH: process.env.PATH,
    coagent8_CONFIG: 'C:\\Users\\someone\\.coagent8\\config.json',
    COAGENT8_SESSIONS_DIR: 'C:\\Users\\someone\\.coagent8\\sessions',
    coagent8_HISTORY: '/home/someone/.coagent8/history',
    KEEP_ME: 'yes',
  };
  const { env, root } = createTestEnvironment(inherited);
  try {
    assert.equal(env.coagent8_CONFIG, undefined, 'a test must never write the user config');
    assert.equal(env.COAGENT8_SESSIONS_DIR, undefined);
    assert.equal(env.coagent8_HISTORY, undefined);
    assert.ok(env.coagent8_DIR.startsWith(root), 'the data directory is the suite own');
    assert.equal(env.KEEP_ME, 'yes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
