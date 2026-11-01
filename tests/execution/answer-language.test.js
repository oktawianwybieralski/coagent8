const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withAnswerLanguage } = require('../../src/execution/controller.ts');

test('a backend prompt starts with the answer language, English unless configured', () => {
  const first = withAnswerLanguage('REQUEST', undefined);
  assert.match(first, /^\[ANSWER LANGUAGE\] .*Write your answer in English,/);
  assert.ok(first.endsWith('\nREQUEST'));
  assert.match(withAnswerLanguage('REQUEST', 'Polish'), /Write your answer in Polish,/);
  assert.equal(withAnswerLanguage('REQUEST', null), 'REQUEST', 'null adds no instruction');
});
