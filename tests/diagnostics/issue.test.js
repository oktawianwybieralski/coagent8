'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const {
  generateBugReport,
  sanitizeText,
  GITHUB_NEW_ISSUE_BASE,
  GITHUB_BUG_REPORT_TEMPLATE_URL,
  MAX_ENCODED_ISSUE_URL_LENGTH,
  buildPrefilledIssueUrl,
} = require('../../src/diagnostics/issue.ts');

test('the issue link fills the title and the fields of the bug report form', () => {
  const errorMessage =
    'No file-reading tools or filesystem resources are available, so I could not verify the surrounding syncPage code or authorization call site to confirm rejection precedes every side effect; shell commands were prohibited.';
  const context =
    'Review of card RC26-01-06a3 with backend codex and model gpt-6.1-sol returned BLOCKED with PARTIAL coverage because no file-reading tools or filesystem resources were available to read workspace files outside the diff.';
  const report = generateBugReport({
    errorMessage,
    context,
    doctorReport: {
      backends: {
        codex: { name: 'OpenAI Codex CLI', installed: true, version: 'codex-cli 0.162.0-alpha.17.2' },
        agy: { name: 'Google Gemini (Antigravity agy)', installed: true, version: '1.3.2' },
        claude: { name: 'Claude Code CLI', installed: true, version: '2.1.296 (Claude Code)' },
      },
    },
  });
  const link = report.prompt.match(/\[Submit Bug Report on GitHub\]\(<([^>]+)>\)/)[1];
  assert.equal(link, report.issueUrl);
  assert.ok(report.issueUrl.startsWith(`${GITHUB_BUG_REPORT_TEMPLATE_URL}&title=`));
  assert.ok(!/[\\()\s<>]/.test(link), 'URL must not contain Markdown escapes or delimiters');
  assert.equal(report.pasteRequired, false);
  assert.ok(!report.prompt.includes('```'), 'nothing to copy when the report fits in the link');
  const fields = new URL(report.issueUrl).searchParams;
  assert.equal(fields.get('title'), report.title);
  assert.ok(report.body.includes(fields.get('what-happened')));
  assert.ok(report.body.includes(fields.get('environment')));
  assert.ok(fields.get('what-happened').indexOf(errorMessage) < fields.get('what-happened').indexOf(context), 'the error comes first');

  assert.ok(report.body.includes(context));
  assert.ok(report.body.includes(errorMessage));
  assert.ok(
    report.body.includes(
      '- **Detected CLIs**:\n' +
        '  - **OpenAI Codex CLI**: codex-cli 0.162.0-alpha.17.2\n' +
        '  - **Google Gemini (Antigravity agy)**: 1.3.2\n' +
        '  - **Claude Code CLI**: 2.1.296 (Claude Code)',
    ),
  );
  assert.ok(!report.body.includes('vcodex-cli'));
  assert.ok(!report.body.includes('v1.3.2'));
  assert.ok(report.body.includes('For setup, sign-in or quota problems, add the output of doctor (scope: health).'));
  assert.ok(!/[\r\n]/.test(report.title));
  assert.ok(!report.title.includes('[truncated]'));
  assert.ok(Array.from(report.title).length <= 120);
  assert.ok(!report.prompt.includes('<details>'));

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
  assert.ok(
    unknownVersionReport.body.includes(
      '- **Detected CLIs**:\n' +
        '  - **OpenAI Codex CLI**: unknown\n' +
        '  - **Google Gemini (Antigravity agy)**: 1.3.3 build 2026-10\n' +
        '  - **Claude Code CLI**: Not installed',
    ),
  );
  assert.ok(!unknownVersionReport.body.includes('vunknown'));
});

test('the issue URL round-trips any text and stays below the length ceiling', () => {
  const errorMessage = 'Failure (worker\'s task)! *retry* & body=injected #fragment %23 + / \\ "quoted" \u{1f680} \u0142';
  const context = 'Keep literal %26 and &#x20; and ?title=other&body=other in diagnostics.';
  const report = generateBugReport({ errorMessage, context });
  assert.ok(Buffer.byteLength(report.issueUrl) <= MAX_ENCODED_ISSUE_URL_LENGTH);
  assert.ok(!/[ #&]/.test(report.issueUrl.split('?')[1].replace(/&(title|what-happened|environment)=/g, '')), 'one query field per value');
  const roundTrip = new URL(report.issueUrl).searchParams;
  assert.ok(roundTrip.get('what-happened').includes(errorMessage));
  assert.ok(roundTrip.get('what-happened').includes(context));
  assert.equal(roundTrip.get('body'), null);
  assert.ok(report.body.includes(errorMessage));
  assert.ok(report.body.includes(context));

  for (const error of [
    'Short error',
    'x'.repeat(110),
    'x'.repeat(111),
    'x'.repeat(200),
    'x'.repeat(109) + '\u{1f680}'.repeat(4),
    'First\rSecond',
    'First\u2028Second',
    'First\u2029Second',
    'First\nSecond',
    '  First\t  Second  ',
  ]) {
    const generated = generateBugReport({ errorMessage: error });
    assert.ok(Array.from(generated.title).length <= 120);
    assert.ok(!/[\r\n\u2028\u2029]/.test(generated.title));
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
  const boundedInput = '\u{1f680}'.repeat(1500);
  const sanitizedInput = sanitizeText(boundedInput);
  assert.ok(Buffer.byteLength(sanitizedInput) <= 4096);
  assert.ok(sanitizedInput.endsWith('...[truncated]'));
  const boundedReport = generateBugReport({ errorMessage: boundedInput, context: boundedInput });
  assert.ok(boundedReport.body.includes(sanitizedInput));
  // The full report does not fit; the link keeps the start of "What happened" and the whole environment.
  assert.ok(boundedReport.issueUrl.length <= MAX_ENCODED_ISSUE_URL_LENGTH);
  const shortened = new URL(boundedReport.issueUrl).searchParams;
  assert.match(shortened.get('what-happened'), /^Error:\n\n```text\n\u{1f680}/u);
  assert.ok(shortened.get('what-happened').endsWith('[shortened to fit the form link]'));
  assert.match(shortened.get('environment'), /CoAgent8 MCP Version/);
  assert.equal(boundedReport.pasteRequired, true, 'a shortened link offers the full report');
  assert.ok(boundedReport.prompt.includes('The report was shortened to fit the link'));
  assert.ok(boundedReport.prompt.includes(boundedReport.body));
});

test('titles come from the title option, fall back to the error, and the form falls back to pasting', () => {
  assert.equal(
    generateBugReport({ title: 'Root limit counts idle time', errorMessage: 'Error [ROOT_LIMIT]' }).title,
    '[Bug]: Root limit counts idle time',
  );
  assert.equal(generateBugReport({ title: '[Bug]: Already prefixed' }).title, '[Bug]: Already prefixed');
  assert.equal(generateBugReport({ title: '  ', errorMessage: 'Fallback\nsecond' }).title, '[Bug]: Fallback');
  const empty = generateBugReport({});
  assert.equal(empty.title, '[Bug]: ');
  assert.match(new URL(empty.issueUrl).searchParams.get('what-happened'), /^Describe what you did/);
  assert.ok(!generateBugReport({ title: 'token sk-' + 'A'.repeat(40) }).title.includes('sk-A'), 'the title is redacted');

  // Not even the title and the environment fit: the empty form and a copy block to paste.
  assert.equal(buildPrefilledIssueUrl('t', 'w', 'e'.repeat(100), 120), GITHUB_BUG_REPORT_TEMPLATE_URL);
  const fitted = buildPrefilledIssueUrl('t', 'w'.repeat(500), 'e', 400);
  assert.ok(fitted.length <= 400 && fitted.length > 300, String(fitted.length));
});

test('issue reporting generates sanitized GitHub issue template URL and redacts secrets', async () => {
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
    `Config: {"api_key":"***[REDACTED]***"}, env: password=***[REDACTED]***, header: Authorization: Bearer ***[REDACTED]***, json: {"password":"***[REDACTED]***"}, git: https://***[REDACTED]***@host.com/repo.git, token_url: https://***[REDACTED]***@api.com, user_url: https://***[REDACTED]***@host.com`,
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

  assert.ok(report.issueUrl.startsWith(GITHUB_BUG_REPORT_TEMPLATE_URL));
  assert.ok(report.prompt.includes('The bug report form is filled in'));
  assert.ok(report.prompt.includes(report.issueUrl));
  const secretReport = generateBugReport({ title: secretText, errorMessage: secretText, context: secretText });
  for (const leaked of ['sk-proj12345678901234567890', 'AKIAIOSFODNN7EXAMPLE', 'superSecretToken', encodeURIComponent(os.homedir())]) {
    assert.ok(!decodeURIComponent(secretReport.issueUrl).includes(leaked) && !secretReport.issueUrl.includes(leaked), leaked);
  }
});

test('diagnostic and issue truncation cannot expose recognized credential prefixes', () => {
  const { redactDiagnostic } = require('../../src/security/redaction.ts');
  const { truncateToByteLength } = require('../../src/execution/runtime/stream.ts');
  const key = 'sk-' + 'A'.repeat(40);
  for (const input of [
    '{"api_key":"fixtureSecret',
    "password='fixtureSecret",
    '{"token":"fixtureSecret\\',
    '{"secret":"fixtureSecret\\\n',
  ]) {
    assert.ok(!redactDiagnostic(input).includes('fixtureSecret'));
    assert.ok(!sanitizeText(input).includes('fixtureSecret'));
  }
  for (const budget of [64, 512, 4096, 512 * 1024]) {
    const input = 'x'.repeat(budget - 16) + ' ' + key;
    for (const value of [redactDiagnostic(input, budget), redactDiagnostic(truncateToByteLength(input, budget), budget)]) {
      assert.ok(!value.includes('sk-A'), value.slice(-80));
      assert.ok(Buffer.byteLength(value) <= budget);
    }
  }
  assert.ok(!sanitizeText('x'.repeat(4080) + ' ' + key).includes('sk-A'));
});

test('issue sanitization covers Basic auth, AWS secret keys, semicolons in unquoted passwords, and resists ReDoS', async () => {
  const { redactDiagnostic, redactCredentialFormats } = require('../../src/security/redaction.ts');
  const keys =
    '-----BEGIN PRIVATE KEY-----\nPRIVATE_DER_SECRET\n-----END PRIVATE KEY-----\n{"aws_access_key_id":"QUOTED_ID_SECRET","aws_secret_access_key":"QUOTED_AWS_SECRET"}';
  assert.ok(!redactCredentialFormats(keys).includes('PRIVATE_DER_SECRET'));
  for (const secret of ['PRIVATE_DER_SECRET', 'QUOTED_ID_SECRET', 'QUOTED_AWS_SECRET']) assert.ok(!redactDiagnostic(keys).includes(secret));
  // Test Basic auth, temporary AWS keys (ASIA), and complex passwords with semicolons and equals
  const leakedText =
    'Authorization: Basic dXNlcjpwYXNzd29yZA== and AWS_ACCESS_KEY_ID=ASIA1234567890ABCDEF and AWS_SECRET_ACCESS_KEY=superSecretValue and password=abc;def=ghi and aws_session_token=xyz123';
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
  const codeText =
    'Error occurred during test:\n```typescript\nconst proprietarySecret = "internal_secret_value";\n```\n~~~python\nsecret_python = 42\n~~~\ndiff --git a/src/secret.js b/src/secret.js\n+ secret diff\n';
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
  const embeddedFenceCode =
    '~~~markdown\ncode here:\n```javascript\nconst leakedInner = "secret123";\n```\nconst leakedAfter = "secret456";\n~~~';
  const sanitizedEmbedded = sanitizeText(embeddedFenceCode);
  assert.ok(!sanitizedEmbedded.includes('leakedInner'));
  assert.ok(!sanitizedEmbedded.includes('leakedAfter'));

  // ReDoS: the credential patterns run on the whole input, so sanitizing must scale linearly.
  // A 4x larger input is timed against a smaller one (best of three each) instead of a fixed
  // wall-clock limit, which a loaded runner under coverage exceeded (128 ms for 40,000
  // characters, macos-latest, Node 26, 2026-10-19). A 4x step still left too little margin
  // (16.6 ms to 167.6 ms, macos-latest, Node 24, 2026-11-01), so the larger input is 16x:
  // linear work grows about 16x, quadratic 256x.
  const bestOf3 = size => {
    const text = 'a'.repeat(size);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = process.hrtime.bigint();
      sanitizeText(text);
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
  };
  const small = bestOf3(400_000),
    large = bestOf3(6_400_000);
  assert.ok(
    large < small * 64 + 20,
    `sanitizing grew from ${small.toFixed(1)} ms to ${large.toFixed(1)} ms for 16x the input, possible ReDoS`,
  );
  assert.ok(sanitizeText('a'.repeat(40000)).length <= 4096, 'Bounded length should be enforced');
});

test('AUDIT-001-A19: free text has no safe boundary after a diff, so everything after it stays redacted', () => {
  const { sanitizeText } = require('../../src/diagnostics/issue.ts');
  const diffWithLookalikes = [
    'Review failed after this change:',
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    '+const key = "sk-live-secretvalue1234567890";',
    '',
    '## Error',
    '+console.log("private payload");',
    '```',
    'Error: PROTOCOL_ERROR after the diff',
  ].join('\n');
  const clean = sanitizeText(diffWithLookalikes);
  // The diff may itself contain blank lines, headings and fences, so none of them ends it.
  assert.ok(clean.startsWith('Review failed after this change:'), 'text before the diff is kept');
  assert.match(clean, /\[git diff redacted for privacy\]/);
  for (const leaked of ['secretvalue', 'private payload', 'src/a.ts']) assert.ok(!clean.includes(leaked), leaked);
  // The cost of that rule: a diagnostic written after the diff is lost too (A20 is skipped).
  assert.ok(!clean.includes('PROTOCOL_ERROR after the diff'));
});
