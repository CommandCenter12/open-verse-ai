import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAsk } from '../src/ask.js';
import { tryMath } from '../src/math.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const REPO_URL = 'https://github.com/CommandCenter12/open-verse-ai';

function fakeAI(reply = 'Paris is the capital of France.') {
  const calls = [];
  return { calls, run: async (model, input) => { calls.push({ model, input }); if (reply instanceof Error) throw reply; return { response: reply }; } };
}
const quiet = { error() {} };
function run(question, { ai = fakeAI(), sourcesOnly = false, quota = { ok: true }, env = {} } = {}) {
  let reserved = 0;
  const p = resolveAsk({
    index: INDEX, question, topK: 3, sourcesOnly, log: quiet,
    env: { REPO_URL, AI: ai, ...env },
    reserveGeneral: async () => { reserved++; return quota; },
  });
  return p.then((r) => ({ r, ai, reserved: () => reserved }));
}

test('math: exact arithmetic without the model', async () => {
  const { r, ai } = await run('1+1');
  assert.equal(r.mode, 'math');
  assert.equal(r.answer, '2');
  assert.equal(ai.calls.length, 0);
  for (const [q, want] of [['what is 2 + 3 * 4?', '14'], ['(1+2)^2', '9'], ['-2^2', '-4'], ['0.1+0.2', '0.3'], ['7 % 4', '3'], ['10 ÷ 4', '2.5']]) {
    assert.equal(tryMath(q).result, want, q);
  }
  assert.equal(tryMath('1/0').error, 'Division by zero is undefined.');
  assert.equal(tryMath('1 + 1 apples'), null);
  assert.equal(tryMath('2024'), null);
  assert.equal(tryMath('2^^3'), null);
});

test('docs answers keep citations and never call the model', async () => {
  const { r, ai, reserved } = await run('How do I tune a PID controller?');
  assert.equal(r.mode, 'docs');
  assert.match(r.sources[0].url, /CommandCenter12\/open-verse-ai\/blob\/main\/knowledge\//);
  assert.equal(ai.calls.length, 0);
  assert.equal(reserved(), 0);
});

test('general fallback uses Llama with a labelled, uncited answer', async () => {
  const { r, ai, reserved } = await run('What is the capital of France?');
  assert.equal(r.mode, 'general');
  assert.equal(r.answer, 'Paris is the capital of France.');
  assert.equal(r.confidence, 'unverified');
  assert.deepEqual(r.sources, []);
  assert.match(r.note, /not from the Open Verse Ai knowledge base/);
  assert.equal(ai.calls[0].model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(ai.calls[0].input.messages[1].content, 'What is the capital of France?');
  assert.equal(reserved(), 1);
});

test('general finance answers carry the disclaimer', async () => {
  const { r } = await run('Should I buy Tesla stock today?', { ai: fakeAI('I cannot recommend specific trades.') });
  assert.equal(r.mode, 'general');
  assert.match(r.disclaimer, /not financial advice/);
});

test('sources_only, project questions, disabled AI and quota keep answered:false', async () => {
  let { r, ai } = await run('What is the capital of France?', { sourcesOnly: true });
  assert.equal(r.answered, false); assert.equal(r.general_unavailable, 'sources_only'); assert.equal(ai.calls.length, 0);

  ({ r, ai } = await run('Does Open Verse Ai have a /v1/translate endpoint?'));
  assert.equal(r.answered, false); assert.equal(r.general_unavailable, 'project_question'); assert.equal(ai.calls.length, 0);

  ({ r } = await run('What is the capital of France?', { env: { GENERAL_ENABLED: 'false' } }));
  assert.equal(r.general_unavailable, 'disabled');

  ({ r } = await run('What is the capital of France?', { env: { AI: undefined } }));
  assert.equal(r.general_unavailable, 'disabled');

  ({ r, ai } = await run('What is the capital of France?', { quota: { ok: false, reason: 'general_quota_exceeded' } }));
  assert.equal(r.answered, false); assert.equal(r.general_unavailable, 'general_quota_exceeded'); assert.equal(ai.calls.length, 0);
});

test('model errors degrade to answered:false instead of a 500', async () => {
  const { r } = await run('What is the capital of France?', { ai: fakeAI(new Error('boom')) });
  assert.equal(r.answered, false);
  assert.equal(r.general_unavailable, 'error');
});

test('stopword-only questions go to the model when allowed, else 400', async () => {
  const { r } = await run('who are you?');
  assert.equal(r.mode, 'general');
  await assert.rejects(run('who are you?', { sourcesOnly: true }), { code: 'no_searchable_terms' });
});
