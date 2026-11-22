import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answer, validateQuestion } from '../src/qa.js';
import { generateKey, isWellFormed, sha256Hex } from '../src/keys.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const ask = (q) => answer(INDEX, q, 3, 'https://github.com/example/open-verse-ai');

test('answers a mechatronics question with a citation', () => {
  const r = ask('How do I tune a PID controller?');
  assert.equal(r.answered, true);
  assert.equal(r.sources[0].section, 'Tuning a PID controller');
  assert.match(r.sources[0].url, /mechatronics-fundamentals\.md#tuning-a-pid-controller$/);
});

test('answers a stock question and attaches the finance disclaimer', () => {
  const r = ask('How is RSI calculated?');
  assert.equal(r.answered, true);
  assert.match(r.answer, /RSI = 100/);
  assert.match(r.disclaimer, /not financial advice/);
});

test('answers a project question', () => {
  const r = ask('What happens if I exceed the rate limit?');
  assert.equal(r.answered, true);
  assert.equal(r.sources[0].file, 'knowledge/open-verse-ai-api.md');
});

test('refuses off-topic questions instead of guessing', () => {
  const r = ask('What is the best pizza topping in Naples?');
  assert.equal(r.answered, false);
  assert.equal(r.answer, null);
  assert.deepEqual(r.sources, []);
});

test('rejects empty, stopword-only and oversized questions', () => {
  assert.throws(() => validateQuestion({ question: '   ' }), { code: 'empty_question' });
  assert.throws(() => validateQuestion({}), { code: 'empty_question' });
  assert.throws(() => validateQuestion({ question: 'x'.repeat(501) }), { code: 'question_too_long' });
  assert.throws(() => validateQuestion({ question: 'hi', top_k: 1 }), { code: 'question_too_short' });
  assert.throws(() => validateQuestion({ question: 'what is', top_k: 9 }), { code: 'invalid_top_k' });
  assert.throws(() => ask('what is the'), { code: 'no_searchable_terms' });
});

test('keys are random, well-formed and hashed to 64 hex chars', async () => {
  const a = generateKey();
  const b = generateKey();
  assert.notEqual(a, b);
  assert.ok(isWellFormed(a));
  assert.ok(!isWellFormed('ova_short'));
  assert.match(await sha256Hex(a), /^[0-9a-f]{64}$/);
});
