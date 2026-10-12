'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { generateBugReport, sanitizeText, GITHUB_NEW_ISSUE_BASE } = require('../../src/diagnostics/issue.ts');

test('issue link preserves the owner-reported diagnostic through one URL decode', () => {
  const errorMessage = 'No file-reading tools or filesystem resources are available, so I could not verify the surrounding syncPage code or authorization call site to confirm rejection precedes every side effect; shell commands were prohibited.';
  const context = 'Review of card RC26-01-06a3 with backend codex and model gpt-6.1-sol returned BLOCKED with PARTIAL coverage because no file-reading tools or filesystem resources were available to read workspace files outside the diff.';
  const report = generateBugReport({ errorMessage, context, doctorReport: { backends: {
    codex: { name: 'OpenAI Codex CLI', installed: true, version: 'codex-cli 0.162.0-alpha.17.2' },
    agy: { name: 'Google Gemini (Antigravity agy)', installed: true, version: '1.3.2' },
    claude: { name: 'Claude Code CLI', installed: true, version: '2.1.296 (Claude Code)' },
  } } });
  const link = report.prompt.match(/\[Submit Bug Report on GitHub\]\(<([^>]+)>\)/)[1];
  const copiedLink = report.prompt.match(/Copyable issue URL:\n\n```text\n([^\n]+)\n```/)[1];
  assert.equal(link, report.issueUrl);
  assert.equal(copiedLink, link);
  assert.ok(!/[\\()\s]/.test(link), 'URL must not contain Markdown escapes or delimiters');
  const url = new URL(link);
  assert.deepEqual([...url.searchParams.keys()], ['title', 'body']);
  assert.equal(url.searchParams.get('title'), report.title);
  assert.equal(url.searchParams.get('body'), report.body);
  assert.ok(!/[!'()*]/.test(url.search));
  assert.ok(report.body.includes(context));
  assert.ok(report.body.includes(errorMessage));
  assert.ok(report.body.includes(
    '- **Detected CLIs**:\n' +
    '  - **OpenAI Codex CLI**: codex-cli 0.162.0-alpha.17.2\n' +
    '  - **Google Gemini (Antigravity agy)**: 1.3.2\n' +
    '  - **Claude Code CLI**: 2.1.296 (Claude Code)'
  ));
  assert.ok(!report.body.includes('vcodex-cli'));
  assert.ok(!report.body.includes('v1.3.2'));
  assert.ok(!report.body.includes('v2.1.296'));
  assert.ok(!/[\r\n]/.test(report.title));
  assert.ok(!report.title.includes('[truncated]'));
  assert.ok(Array.from(report.title).length <= 120);
  assert.ok(!report.prompt.includes('<details>'));
  assert.ok(report.prompt.endsWith(`Preview Sanitized Report\n\n${report.body}`));

  const emptyBackendsReport = generateBugReport({ errorMessage: 'Error', doctorReport: { backends: {} } });
  assert.ok(emptyBackendsReport.body.includes('- **Detected CLIs**: Not provided'));

  const unknownVersionReport = generateBugReport({
    errorMessage: 'Error',
    doctorReport: {
      backends: {
        codex: { name: 'OpenAI Codex CLI', installed: true },
        agy: { name: 'Google Gemini (Antigravity agy)', installed: true, version: '1.3.3\nbuild 2026-10' },
        claude: { name: 'Claude Code CLI', installed: false },
      },
    },
  });
  assert.ok(unknownVersionReport.body.includes(
    '- **Detected CLIs**:\n' +
    '  - **OpenAI Codex CLI**: unknown\n' +
    '  - **Google Gemini (Antigravity agy)**: 1.3.3 build 2026-10\n' +
    '  - **Claude Code CLI**: Not installed'
  ));
  assert.ok(!unknownVersionReport.body.includes('vunknown'));
});

test('issue URL preserves punctuation, Unicode and literal URL-like text without extra parameters', () => {
  const errorMessage = "Failure (worker's task)! *retry* & body=injected #fragment %23 + / \\ \"quoted\" \u{1f680} \u0142";
  const context = 'Keep literal %26 and &#x20; and ?title=other&body=other in diagnostics.';
  const report = generateBugReport({ errorMessage, context });
  const url = new URL(report.issueUrl);
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.get('title'), report.title);
  assert.equal(url.searchParams.get('body'), report.body);
  assert.ok(report.body.includes(errorMessage));
  assert.ok(report.body.includes(context));
  assert.deepEqual([...url.searchParams.keys()], ['title', 'body']);
  for (const error of ['Short error', 'x'.repeat(110), 'x'.repeat(111), 'x'.repeat(200), 'x'.repeat(109) + '\u{1f680}'.repeat(4), 'First\rSecond', 'First\u2028Second', 'First\u2029Second', 'First\nSecond', '  First\t  Second  ']) {
    const generated = generateBugReport({ errorMessage: error });
    assert.ok(Array.from(generated.title).length <= 120);
    assert.ok(!/[\r\n\u2028\u2029]/.test(generated.title));
    assert.equal(new URL(generated.issueUrl).searchParams.get('title'), generated.title);
  }
  assert.equal(generateBugReport({ errorMessage: 'x'.repeat(111) }).title, `[Bug]: ${'x'.repeat(110)}...`);
  assert.equal(generateBugReport({ errorMessage: 'x'.repeat(110) }).title, `[Bug]: ${'x'.repeat(110)}`);
  assert.equal(generateBugReport({ errorMessage: '  First\t  Second  ' }).title, '[Bug]: First Second');
  const longContext = 'Repro, expected/actual behavior and timing evidence. '.repeat(50) + 'CONTEXT_END';
  const longDiagnostic = 'Diagnostic details. '.repeat(100) + 'DIAGNOSTIC_END';
  const completeReport = generateBugReport({ errorMessage: longDiagnostic, context: longContext });
  assert.ok(completeReport.body.includes(longContext));
  assert.ok(completeReport.body.includes(longDiagnostic));
  assert.ok(!completeReport.body.includes('[truncated]'));
  assert.equal(new URL(completeReport.issueUrl).searchParams.get('body'), completeReport.body);
  const boundedInput = '\u{1f680}'.repeat(1500);
  const sanitizedInput = sanitizeText(boundedInput);
  assert.ok(Buffer.byteLength(sanitizedInput) <= 4096);
  assert.ok(sanitizedInput.endsWith('...[truncated]'));
  const boundedReport = generateBugReport({ errorMessage: boundedInput, context: boundedInput });
  assert.ok(boundedReport.body.includes(sanitizedInput));
  assert.equal(new URL(boundedReport.issueUrl).searchParams.get('body'), boundedReport.body);
});

test('issue reporting generates sanitized GitHub pre-filled issue URL and redacts secrets', async () => {
  const secretText = `Error at ${os.homedir()}/projects/secret: connection failed with API key sk-proj12345678901234567890, AWS key AKIAIOSFODNN7EXAMPLE, Slack ${['xo', 'xb-'].join('')}1234567890-abcdefgh, and api_key="secretPassword123" and https://api.com?token=superSecretToken. Also Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.`;
  const sanitized = sanitizeText(secretText);

  assert.ok(!sanitized.includes('sk-proj12345678901234567890'));
  assert.ok(sanitized.includes('sk-***[REDACTED]***'));
  assert.ok(sanitized.includes('Bearer ***[REDACTED]***'));
  assert.ok(sanitized.includes('AKIA***[REDACTED]***'));
  assert.ok(sanitized.includes('xox-***[REDACTED]***'));
  assert.ok(sanitized.includes('api_key="***[REDACTED]***"'));
  assert.ok(sanitized.includes('token=***[REDACTED]***'));
  assert.ok(!sanitized.includes(os.homedir()));
  assert.ok(sanitized.includes('~'));

  // Test edge cases: JSON quoted keys, passwords with punctuation, short Bearer tokens, URL credentials
  const edgeSecretText = `Config: {"api_key":"abcd1234SECRET"}, env: password=abc!def123, header: Authorization: Bearer abc, json: {"password":"abc;def"}, git: https://alice:superSecret@host.com/repo.git, token_url: https://secretToken123@api.com, user_url: https://user:@host.com`;
  const sanitizedEdge = sanitizeText(edgeSecretText);
  assert.equal(
    sanitizedEdge,
    `Config: {"api_key":"***[REDACTED]***"}, env: password=***[REDACTED]***, header: Authorization: Bearer ***[REDACTED]***, json: {"password":"***[REDACTED]***"}, git: https://***[REDACTED]***@host.com/repo.git, token_url: https://***[REDACTED]***@api.com, user_url: https://***[REDACTED]***@host.com`
  );

  // Test safe surrogate handling with emojis
  const emojiError = 'Crash with rocket 🚀'.repeat(200);
  const emojiReport = generateBugReport({
    errorMessage: emojiError,
    context: 'Testing emoji surrogates',
  });
  assert.doesNotThrow(() => {
    decodeURIComponent(emojiReport.issueUrl);
  });

  const report = generateBugReport({
    errorMessage: 'Process failed with exit code 1',
    context: 'Running omniagent_review on uncommitted changes',
    doctorReport: {
      backends: {
        codex: { name: 'OpenAI Codex CLI', installed: true, version: '0.160.0' },
        claude: { name: 'Claude Code CLI', installed: false },
      },
    },
  });

  assert.ok(report.issueUrl.startsWith(GITHUB_NEW_ISSUE_BASE));
  assert.ok(report.issueUrl.includes('title='));
  assert.ok(report.issueUrl.includes('body='));
  assert.ok(report.prompt.includes('Would you like to report this issue to GitHub'));
  assert.ok(report.prompt.includes(GITHUB_NEW_ISSUE_BASE));
});

test('diagnostic and issue truncation cannot expose recognized credential prefixes', () => {
  const {redactDiagnostic}=require('../../src/security/redaction.ts');
  const {truncateToByteLength}=require('../../src/execution/runtime/stream.ts');
  const key='sk-'+'A'.repeat(40);
  for(const input of ['{"api_key":"fixtureSecret','password=\'fixtureSecret','{"token":"fixtureSecret\\','{"secret":"fixtureSecret\\\n']) {
    assert.ok(!redactDiagnostic(input).includes('fixtureSecret'));assert.ok(!sanitizeText(input).includes('fixtureSecret'));
  }
  for(const budget of [64,512,4096,512*1024]){
    const input='x'.repeat(budget-16)+' '+key;
    for(const value of [redactDiagnostic(input,budget),redactDiagnostic(truncateToByteLength(input,budget),budget)]){
      assert.ok(!value.includes('sk-A'),value.slice(-80));assert.ok(Buffer.byteLength(value)<=budget);
    }
  }
  assert.ok(!sanitizeText('x'.repeat(4080)+' '+key).includes('sk-A'));
});

test('issue sanitization covers Basic auth, AWS secret keys, semicolons in unquoted passwords, and resists ReDoS', async () => {
  const {redactDiagnostic, redactCredentialFormats}=require('../../src/security/redaction.ts');
  const keys='-----BEGIN PRIVATE KEY-----\nPRIVATE_DER_SECRET\n-----END PRIVATE KEY-----\n{"aws_access_key_id":"QUOTED_ID_SECRET","aws_secret_access_key":"QUOTED_AWS_SECRET"}';
  assert.ok(!redactCredentialFormats(keys).includes('PRIVATE_DER_SECRET'));
  for(const secret of ['PRIVATE_DER_SECRET','QUOTED_ID_SECRET','QUOTED_AWS_SECRET'])assert.ok(!redactDiagnostic(keys).includes(secret));
  // Test Basic auth, temporary AWS keys (ASIA), and complex passwords with semicolons and equals
  const leakedText = 'Authorization: Basic dXNlcjpwYXNzd29yZA== and AWS_ACCESS_KEY_ID=ASIA1234567890ABCDEF and AWS_SECRET_ACCESS_KEY=superSecretValue and password=abc;def=ghi and aws_session_token=xyz123';
  const sanitized = sanitizeText(leakedText);
  assert.ok(!sanitized.includes('dXNlcjpwYXNzd29yZA=='));
  assert.ok(!sanitized.includes('ASIA1234567890ABCDEF'));
  assert.ok(!sanitized.includes('superSecretValue'));
  assert.ok(!sanitized.includes('abc;def=ghi'));
  assert.ok(!sanitized.includes('def=ghi'));
  assert.ok(!sanitized.includes('xyz123'));
  assert.ok(sanitized.includes('Authorization: Basic ***[REDACTED]***'));
  assert.ok(sanitized.includes('AWS_ACCESS_KEY_ID=***[REDACTED]***'));
  assert.ok(sanitized.includes('AWS_SECRET_ACCESS_KEY=***[REDACTED]***'));
  assert.ok(sanitized.includes('password=***[REDACTED]***'));
  assert.ok(sanitized.includes('aws_session_token=***[REDACTED]***'));

  // Test code confidentiality: raw code blocks, unterminated blocks, tildes, and git diffs
  const codeText = 'Error occurred during test:\n```typescript\nconst proprietarySecret = "internal_secret_value";\n```\n~~~python\nsecret_python = 42\n~~~\ndiff --git a/src/secret.js b/src/secret.js\n+ secret diff\n';
  const sanitizedCode = sanitizeText(codeText);
  assert.ok(!sanitizedCode.includes('proprietarySecret'));
  assert.ok(!sanitizedCode.includes('secret_python'));
  assert.ok(!sanitizedCode.includes('+ secret diff'));
  assert.ok(sanitizedCode.includes('[code block redacted for privacy]'));
  assert.ok(sanitizedCode.includes('[git diff redacted for privacy]'));

  // Unterminated code block (e.g. truncated closing fence)
  const unterminatedCode = 'Prefix info:\n```typescript\nconst unterminatedSecret = "must_not_leak";';
  const sanitizedUnterminated = sanitizeText(unterminatedCode);
  assert.ok(!sanitizedUnterminated.includes('unterminatedSecret'));
  assert.ok(sanitizedUnterminated.includes('[code block redacted for privacy]'));

  // Embedded fence delimiter test: tilde block containing ``` must not terminate early
  const embeddedFenceCode = '~~~markdown\ncode here:\n```javascript\nconst leakedInner = "secret123";\n```\nconst leakedAfter = "secret456";\n~~~';
  const sanitizedEmbedded = sanitizeText(embeddedFenceCode);
  assert.ok(!sanitizedEmbedded.includes('leakedInner'));
  assert.ok(!sanitizedEmbedded.includes('leakedAfter'));

  // ReDoS test: 40,000 'a' characters must sanitize linearly in under 100ms
  const longA = 'a'.repeat(40000);
  const start = Date.now();
  const sanitizedA = sanitizeText(longA);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `Sanitization took too long (${elapsed}ms), possible ReDoS`);
  assert.ok(sanitizedA.length <= 4096, 'Bounded length should be enforced');
});
