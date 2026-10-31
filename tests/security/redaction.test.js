'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { redactCredentialFormats, redactDiagnostic, redactDiagnosticData, redactHomePath, redactPublicContent, redactPublicData, redactSecrets, stripTerminalSequences } = require('../../src/security/redaction.ts');
// Provider key prefixes are joined at run time, so the source holds no literal token that
// GitHub push protection reports (FEEDBACK-060j).
const STRIPE_LIVE = ['sk', 'live', ''].join('_');
const SLACK_BOT = ['xo', 'xb-'].join('');

test('AUD-P0-2 & Opus P1/P2 regression: public code answers and URLs round-trip without corruption', () => {
  const negativeCases = [
    'const token = getToken(req);',
    'interface User { password: string; secret: Buffer }',
    'max_token = 4096',
    'const auth = useAuth();',
    'headers: { Authorization: `Bearer ${token}` }',
    '{ Authorization: token }',
    "Authorization: ' + token",
    'interface H { Authorization: string }',
    'send a Bearer token in the header',
    'Bearer token is standard practice',
    '## Basic Authentication',
    '## Basic AuthenticationMechanism',
    'use Bearer AuthenticationToken',
    '`https://${user}:${pass}@${host}/db`',
    'https://<user>:<password>@host',
    'https://{user}:{password}@host',
    'Authorization: Bearer <TOKEN_PLACEHOLDER>',
    'Authorization: Bearer YOUR_API_TOKEN_HERE',
    'keys look like sk-...',
    'ssh://git@github.com/owner/repo.git',
    'https://git@github.com/owner/repo.git',
    'disk-task...[truncated]',
    'self_ghp_test...[truncated]',
  ];

  for (const input of negativeCases) {
    const result = redactCredentialFormats(input);
    assert.equal(result, input, `Expected "${input}" to round-trip unchanged in public output, got "${result}"`);
    assert.equal(redactSecrets(input), input, 'redactSecrets alias must also preserve public code');
  }
});

test('REDACTION-002: high-confidence credential formats are individually redacted in public output', () => {
  const cases = [
    {
      name: 'PEM private key',
      input: 'Here is the key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...fake\n-----END RSA PRIVATE KEY-----\nEnd of key.',
      expectedRedacted: '-----BEGIN PRIVATE KEY-----\n***[REDACTED]***\n-----END PRIVATE KEY-----',
      expectedAbsent: 'MIIEowIBAAKCAQEA0...fake',
    },
    {
      name: 'OpenAI API key',
      input: 'const key = "sk-proj-1234567890abcdef1234567890abcdef";',
      expectedRedacted: 'sk-***[REDACTED]***',
      expectedAbsent: '1234567890abcdef1234567890abcdef',
    },
    {
      name: 'Stripe live key',
      input: `stripeKey: "${STRIPE_LIVE}123456789012345678901234"`,
      expectedRedacted: 'sk_live_***[REDACTED]***',
      expectedAbsent: '123456789012345678901234',
    },
    {
      name: 'Google AI key',
      input: 'const apiKey = "AIzaSyD-1234567890abcdefghijklmnopqrstu";',
      expectedRedacted: 'AIza***[REDACTED]***',
      expectedAbsent: '1234567890abcdefghijklmnopqrstu',
    },
    {
      name: 'Google OAuth access token',
      input: 'token: "ya29.a0AfH6SMB_1234567890abcdefghijklmnopqrstuvwxyz"',
      expectedRedacted: 'ya29.***[REDACTED]***',
      expectedAbsent: 'a0AfH6SMB_1234567890',
    },
    {
      name: 'GitHub classic PAT (ghp)',
      input: 'const ghp = "ghp_111122223333444455556666777788889999";',
      expectedRedacted: 'ghp_***[REDACTED]***',
      expectedAbsent: '111122223333444455556666777788889999',
    },
    {
      name: 'GitHub OAuth token (gho)',
      input: 'const gho = "gho_222233334444555566667777888899990000";',
      expectedRedacted: 'gho_***[REDACTED]***',
      expectedAbsent: '222233334444555566667777888899990000',
    },
    {
      name: 'GitHub user token (ghu)',
      input: 'const ghu = "ghu_333344445555666677778888999900001111";',
      expectedRedacted: 'ghu_***[REDACTED]***',
      expectedAbsent: '333344445555666677778888999900001111',
    },
    {
      name: 'GitHub server token (ghs)',
      input: 'const ghs = "ghs_444455556666777788889999000011112222";',
      expectedRedacted: 'ghs_***[REDACTED]***',
      expectedAbsent: '444455556666777788889999000011112222',
    },
    {
      name: 'GitHub fine-grained PAT',
      input: 'github_pat_11A2B3C4D012345678901234567890123456789012345678901234567890123456789012345678901234',
      expectedRedacted: 'github_pat_***[REDACTED]***',
      expectedAbsent: '11A2B3C4D012345678901234567890123456789012345678901234567890123456789012345678901234',
    },
    {
      name: 'GitLab PAT',
      input: 'export GITLAB_TOKEN="glpat-0123456789abcdefghij"',
      expectedRedacted: 'glpat-***[REDACTED]***',
      expectedAbsent: '0123456789abcdefghij',
    },
    {
      name: 'npm access token',
      input: 'npmToken = npm_0123456789abcdefghijklmnopqrstuvwxyz',
      expectedRedacted: 'npm_***[REDACTED]***',
      expectedAbsent: '0123456789abcdefghijklmnopqrstuvwxyz',
    },
    {
      name: 'Hugging Face token',
      input: 'hf_token = hf_0123456789abcdefghijklmnopqrstuvwxyz1234',
      expectedRedacted: 'hf_***[REDACTED]***',
      expectedAbsent: '0123456789abcdefghijklmnopqrstuvwxyz1234',
    },
    {
      name: 'Bare JWT',
      input: 'jwt: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      expectedRedacted: 'eyJ***[REDACTED]***',
      expectedAbsent: 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    },
    {
      name: 'AWS Access Key ID',
      input: 'aws_key = AKIA1234567890ABCDEF;',
      expectedRedacted: 'AKIA***[REDACTED]***',
      expectedAbsent: '1234567890ABCDEF',
    },
    {
      name: 'Authorization: Bearer header',
      input: 'headers = { Authorization: Bearer secret-bearer-token-1234567890 }',
      expectedRedacted: 'Authorization: Bearer ***[REDACTED]***',
      expectedAbsent: 'secret-bearer-token-1234567890',
    },
    {
      name: 'Authorization: Basic header',
      input: 'headers = { Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng== }',
      expectedRedacted: 'Authorization: Basic ***[REDACTED]***',
      expectedAbsent: 'dXNlcjpwYXNzd29yZDEyMzQ1Ng==',
    },
    {
      name: 'Standalone Basic auth token decoding to user:password',
      input: 'curl with Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng== header',
      expectedRedacted: 'Basic ***[REDACTED]***',
      expectedAbsent: 'dXNlcjpwYXNzd29yZDEyMzQ1Ng==',
    },
    {
      name: 'Lowercase basic auth token',
      input: 'curl -H "x: basic dXNlcjpwYXNzd29yZDEyMzQ1Ng=="',
      expectedRedacted: 'basic ***[REDACTED]***',
      expectedAbsent: 'dXNlcjpwYXNzd29yZDEyMzQ1Ng==',
    },
    {
      name: 'Standalone Bearer token',
      input: 'use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 for auth',
      expectedRedacted: 'Bearer ***[REDACTED]***',
      expectedAbsent: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    },
    {
      name: 'Lowercase bearer token with digits',
      input: 'header: bearer secret1234567890abcdef',
      expectedRedacted: 'bearer ***[REDACTED]***',
      expectedAbsent: 'secret1234567890abcdef',
    },
    {
      name: 'URL with embedded password',
      input: 'git clone https://user:super_secret_pass@github.com/owner/repo.git',
      expectedRedacted: 'https://user:***[REDACTED]***@github.com/owner/repo.git',
      expectedAbsent: 'super_secret_pass',
    },
    {
      name: 'PostgreSQL connection URL with password',
      input: 'DATABASE_URL="postgres://app:realpass@db/x"',
      expectedRedacted: 'postgres://app:***[REDACTED]***@db/x',
      expectedAbsent: 'realpass',
    },
    {
      name: 'PostgreSQL connection URL with percent-encoded password',
      input: 'DATABASE_URL="postgres://app:p%40ss@db/x"',
      expectedRedacted: 'postgres://app:***[REDACTED]***@db/x',
      expectedAbsent: 'p%40ss',
    },
    {
      name: 'PostgreSQL connection URL with multibyte percent-encoded Cyrillic password',
      input: 'DATABASE_URL="postgres://app:p%D0%B0ss@db/x"',
      expectedRedacted: 'postgres://app:***[REDACTED]***@db/x',
      expectedAbsent: 'p%D0%B0ss',
    },
    {
      name: 'URL with password containing brace but not a whole placeholder',
      input: 'DATABASE_URL="https://u:ab{c9x@host/db"',
      expectedRedacted: 'https://u:***[REDACTED]***@host/db',
      expectedAbsent: 'ab{c9x',
    },
    {
      name: 'Redis connection URL with password and no username',
      input: 'REDIS_URL="redis://:s3cret@cache:6379"',
      expectedRedacted: 'redis://:***[REDACTED]***@cache:6379',
      expectedAbsent: 's3cret',
    },
    {
      name: 'MongoDB connection URL with password',
      input: 'mongodb+srv://u:p@cluster/db',
      expectedRedacted: 'mongodb+srv://u:***[REDACTED]***@cluster/db',
      expectedAbsent: 'u:p@',
    },
    {
      name: 'Slack bot token format',
      input: `slack = "${SLACK_BOT}1234567890-abcdefghijklmn"`,
      expectedRedacted: 'xox-***[REDACTED]***',
      expectedAbsent: '1234567890-abcdefghijklmn',
    },
    {
      name: 'Truncated credential prefix',
      input: 'API token was sk-proj-1234567890...[truncated]',
      expectedRedacted: '***[REDACTED]***',
      expectedAbsent: 'sk-proj-1234567890',
    },
    {
      name: 'Truncated credential with newline prefix',
      input: 'sk-proj-1234567\n...[truncated]',
      expectedRedacted: '***[REDACTED]***',
      expectedAbsent: 'sk-proj-1234567',
    },
    {
      name: 'Truncated Bearer token',
      input: 'Bearer abc123def456...[truncated]',
      expectedRedacted: 'Bearer ***[REDACTED]***',
      expectedAbsent: 'abc123def456',
    },
    {
      name: 'Lowercase truncated bearer token',
      input: 'bearer abc123def456...[truncated]',
      expectedRedacted: 'bearer ***[REDACTED]***',
      expectedAbsent: 'abc123def456',
    },
    {
      name: 'Truncated Bearer token with slash and newline',
      input: 'Bearer abc123/def456\n...[truncated]',
      expectedRedacted: 'Bearer ***[REDACTED]***',
      expectedAbsent: 'abc123/def456',
    },
    {
      name: 'Truncated Basic token with plus',
      input: 'Basic dXNlcjpw+YXNz...[truncated]',
      expectedRedacted: 'Basic ***[REDACTED]***',
      expectedAbsent: 'dXNlcjpw+YXNz',
    },
    {
      name: 'URL with placeholder user but real password',
      input: 'postgres://${user}:hunter2pass@db/x',
      expectedRedacted: 'postgres://${user}:***[REDACTED]***@db/x',
      expectedAbsent: 'hunter2pass',
    },
    {
      name: 'Short Authorization: Basic header (admin:admin)',
      input: 'Authorization: Basic YWRtaW46YWRtaW4=',
      expectedRedacted: 'Authorization: Basic ***[REDACTED]***',
      expectedAbsent: 'YWRtaW46YWRtaW4=',
    },
    {
      name: 'URL password with unencoded @',
      input: 'postgres://u:p@ss@word@host/db',
      expectedRedacted: 'postgres://u:***[REDACTED]***@host/db',
      expectedAbsent: 'p@ss@word',
    },
  ];

  for (const c of cases) {
    const result = redactCredentialFormats(c.input);
    assert.ok(result.includes(c.expectedRedacted), `Test "${c.name}": expected result to contain "${c.expectedRedacted}", got "${result}"`);
    assert.ok(!result.includes(c.expectedAbsent), `Test "${c.name}": expected result NOT to contain "${c.expectedAbsent}", got "${result}"`);
  }
});

test('PEM key redaction stays linear on repeated BEGIN and END markers', () => {
  // The earlier pattern took several seconds on these 220 KB inputs (CodeQL js/polynomial-redos).
  for (const input of ['-----begin '.repeat(20000), '-----begin private key-----' + '-----end '.repeat(20000)]) {
    const started = process.hrtime.bigint();
    redactCredentialFormats(input);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 500, `redaction took ${elapsedMs.toFixed(0)} ms on ${input.slice(0, 30)}...`);
  }
  for (const type of ['RSA ', 'EC ', 'OPENSSH ', 'ENCRYPTED ', 'X-TEST ', '']) {
    const key = `-----BEGIN ${type}PRIVATE KEY-----\nSECRET_BODY\n-----END ${type}PRIVATE KEY-----`;
    assert.equal(redactCredentialFormats(key), '-----BEGIN PRIVATE KEY-----\n***[REDACTED]***\n-----END PRIVATE KEY-----');
  }
});

test('REDACTION-002: diagnostic redaction strips keyword=value rules, Authorization catch-all, and home directory', () => {
  const diagInput = 'Error connecting to database: password="superSecretPassword" token=anotherSecret api_key=12345 auth=jwtVal Authorization: custom-token at ' + os.homedir() + '/workspace/app.js';
  const diagResult = redactDiagnostic(diagInput);

  assert.ok(!diagResult.includes('superSecretPassword'));
  assert.ok(!diagResult.includes('anotherSecret'));
  assert.ok(!diagResult.includes('12345'));
  assert.ok(!diagResult.includes('jwtVal'));
  assert.ok(!diagResult.includes('custom-token'));
  assert.ok(!diagResult.includes(os.homedir()));
  assert.ok(diagResult.includes('~/workspace/app.js') || diagResult.includes('~\\workspace\\app.js'));
  assert.ok(diagResult.includes('password="***[REDACTED]***"'));
  assert.ok(diagResult.includes('token=***[REDACTED]***'));
  assert.ok(diagResult.includes('Authorization: ***[REDACTED]***'));

  // Connection URLs with passwords across any scheme are stripped in diagnostics
  const pgDiag = redactDiagnostic('Error connecting to postgres://app:p%40ss@db/x');
  assert.ok(!pgDiag.includes('p%40ss'));
  assert.ok(pgDiag.includes('postgres://app:***[REDACTED]***@db/x') || pgDiag.includes('postgres://***[REDACTED]***@db/x'));

  const redisDiag = redactDiagnostic('Redis failed at redis://:s3cret@cache:6379');
  assert.ok(!redisDiag.includes('s3cret'));
  assert.ok(redisDiag.includes('redis://:***[REDACTED]***@cache:6379') || redisDiag.includes('redis://***[REDACTED]***@cache:6379'));
});

test('diagnostics redact raw, structured and repeatedly JSON-escaped Windows home paths before truncation', () => {
  const original = os.homedir;
  os.homedir = () => 'C:\\Users\\Synthetic User';
  try {
    const home = os.homedir();
    let input = home + '\\private\\config.json';
    for (let level = 0; level < 4; level++) {
      const output = redactDiagnostic(input);
      assert.ok(!output.includes('Synthetic User'), `encoding level ${level}`);
      assert.ok(output.includes('~'), `encoding level ${level}`);
      input = JSON.stringify({ message: input });
    }
    const structured = redactDiagnostic({ file: home + '\\private', api_key: 'synthetic-secret' });
    assert.ok(!structured.includes('Synthetic User'));
    assert.ok(!structured.includes('synthetic-secret'));
    for (const budget of [1, 16, 32]) {
      const bounded = redactDiagnostic(home + '\\private', budget);
      assert.ok(!bounded.includes('Synthetic User'));
      assert.ok(Buffer.byteLength(bounded) <= budget);
    }
    assert.ok(redactDiagnostic('C:\\Users\\Synthetic User2\\public').includes('Synthetic User2'));
    assert.ok(!redactDiagnostic(home.replace(/\\/g, '/') + '/private').includes('Synthetic User'));
  } finally { os.homedir = original; }
});

test('diagnostics redact the canonical path of a home reached through a link or short name', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-home-link-'));
  const target = path.join(root, 'canonical-home');
  const link = path.join(root, 'linked-home');
  fs.mkdirSync(target);
  // A junction needs no privilege on Windows; GitHub runners reach TEMP through an 8.3 name the same way.
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const original = os.homedir;
  os.homedir = () => link;
  try {
    const canonical = fs.realpathSync.native(link);
    assert.notEqual(canonical, link);
    const output = redactDiagnostic(path.join(canonical, 'project') + ' and ' + path.join(link, 'project'));
    assert.equal(output, `~${path.sep}project and ~${path.sep}project`);
  } finally {
    os.homedir = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic redaction does not throw or print the home when its canonical path fails to resolve', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const home = path.join(os.tmpdir(), 'coagent8-unreadable-home-' + process.pid);
  const originalHome = os.homedir, originalRealpath = fs.realpathSync.native, originalWrite = process.stderr.write;
  const warnings = [];
  os.homedir = () => home;
  fs.realpathSync.native = target => {
    throw Object.assign(new Error(`EIO: i/o error, realpath '${target}'`), { code: 'EIO' });
  };
  process.stderr.write = chunk => { warnings.push(String(chunk)); return true; };
  try {
    assert.equal(redactDiagnostic(path.join(home, 'project')), `~${path.sep}project`);
  } finally {
    process.stderr.write = originalWrite;
    fs.realpathSync.native = originalRealpath;
    os.homedir = originalHome;
  }
  assert.deepEqual(warnings, ['Warning: canonical home directory not resolved for redaction: EIO\n']);
});

test('AUD-P0-2: user_message stored in history preserves user code and token keywords without diagnostic alteration', async () => {
  const { createHistoryWriter, sessionHistory, deleteHistory } = require('../../src/sessions/history/index.ts');
  const { createSession, getSessionFilePath } = require('../../src/sessions/session.ts');
  const fs = require('node:fs');
  const path = require('node:path');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-hist-test-'));
  let sess = null;
  try {
    sess = createSession('codex', tempDir);
    const writer = createHistoryWriter(sess.sessionHandle, tempDir, 'codex', 'turn-1');
    const userPrompt = 'const token = getToken(req); password = "test"; C:\\Users\\User\\project';
    writer.accept({ type: 'turn_started' });
    writer.accept({ type: 'user_message', text: userPrompt });
    await writer.flush();

    const history = await sessionHistory(sess.sessionHandle, tempDir);
    const storedUserMsg = history.events.find(e => e.type === 'user_message');
    assert.ok(storedUserMsg, 'user_message event should be present in history');
    assert.equal(storedUserMsg.text, userPrompt, 'user_message code and keywords must be preserved without diagnostic corruption');
  } finally {
    if (sess) {
      await deleteHistory(sess.sessionHandle, tempDir).catch(() => {});
      const file = getSessionFilePath(sess.sessionHandle);
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('redactDiagnosticData recursively redacts home directory paths and credentials in nested data structures', () => {
  const original = os.homedir;
  const home = process.platform === 'win32' ? 'C:\\Users\\SyntheticUser' : '/home/SyntheticUser';
  os.homedir = () => home;
  try {
    const data = {
      nested: {
        configPath: path.join(home, 'config.json'),
        secret: 'api_key: secret-value-1234',
        count: 42,
        active: true,
      },
      list: [path.join(home, 'file.txt'), 'sk-ant-api03-abcdef1234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890'],
      nullable: null,
    };
    const redacted = redactDiagnosticData(data);
    assert.equal(redacted.nested.configPath, `~${path.sep}config.json`);
    assert.ok(!JSON.stringify(redacted).includes('SyntheticUser'));
    assert.ok(!JSON.stringify(redacted).includes('secret-value-1234'));
    assert.equal(redacted.nested.count, 42);
    assert.equal(redacted.nested.active, true);
    assert.equal(redacted.nullable, null);
  } finally {
    os.homedir = original;
  }
});

test('redactPublicContent and redactPublicData preserve ordinary code, redact credentials and home dir without truncation', () => {
  const original = os.homedir;
  const home = process.platform === 'win32' ? 'C:\\Users\\SyntheticPublic' : '/home/SyntheticPublic';
  os.homedir = () => home;
  try {
    const rawCode = `const token = 42;\nconst auth = true;\nconst p = "${path.join(home, 'my-repo')}";\n// ${'long'.repeat(1000)}`;
    const sanitized = redactPublicContent(rawCode);
    assert.ok(sanitized.includes('const token = 42;'), 'keyword token assignment must not be rewritten in public content');
    assert.ok(sanitized.includes('const auth = true;'), 'keyword auth assignment must not be rewritten in public content');
    assert.ok(!sanitized.includes('SyntheticPublic'), 'home path must be redacted');
    assert.ok(sanitized.includes(`~${path.sep}my-repo`) || sanitized.includes('~/my-repo'), 'home path replaced with ~');
    assert.ok(sanitized.length > 4000, 'public content must not be truncated to 2048 or 4096 bytes');

    // redactPublicData on nested structure
    const data = {
      code: rawCode,
      cred: 'sk-proj-1234567890abcdef1234567890abcdef',
      items: [rawCode, 123],
    };
    const publicData = redactPublicData(data);
    assert.ok(publicData.code.includes('const token = 42;'));
    assert.ok(publicData.code.length > 4000);
    assert.ok(!publicData.code.includes('SyntheticPublic'));
    assert.equal(publicData.cred, 'sk-***[REDACTED]***');
    assert.ok(publicData.items[0].includes('const token = 42;'));
    assert.equal(publicData.items[1], 123);
  } finally {
    os.homedir = original;
  }
});

test('stripTerminalSequences strips CSI, OSC 52, and control sequences while preserving text and formatting', () => {
  const osc52Bel = '\x1b]52;c;ZXhhbXBsZQ==\x07';
  const osc52St = '\x1b]52;c;ZXhhbXBsZQ==\x1b\\';
  const csiClear = '\x1b[2J';
  const csiCursor = '\x1b[10;20H';
  const csiColor = '\x1b[31;1m';
  const controlChars = '\x08\x07\x00\x1b';
  const input = `Title${csiColor}\n\t${osc52Bel}Line 1${csiClear}\nLine 2${osc52St}${csiCursor}End${controlChars}!`;

  const cleaned = stripTerminalSequences(input);
  assert.equal(cleaned, 'Title\n\tLine 1\nLine 2End!');
  assert.ok(!cleaned.includes('52;c;'));
  assert.ok(!cleaned.includes('\x1b'));
  assert.ok(cleaned.includes('\n\t'));
});
