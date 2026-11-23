import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAsk } from '../src/ask.js';
import { numbersIn } from '../src/general.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const run = (reply, question, extra = {}) => {
  const calls = [];
  const AI = { run: async (model, input) => { calls.push({ model, input }); return { choices: [{ message: { content: reply } }] }; } };
  return resolveAsk({ index: INDEX, question, topK: 3, sourcesOnly: false, log: { error() {} }, env: { REPO_URL: 'x', AI }, reserveGeneral: async () => ({ ok: true }), ...extra })
    .then((r) => ({ r, calls }));
};

test('docs answer is rewritten for a 9th grader when every number is kept', async () => {
  const { r, calls } = await run('A common stepper motor moves in 200 small steps per turn (each step is 1.8 degrees). Microstepping splits each step, so 16 times microstepping gives 3200 tiny steps per turn.',
    'How many microsteps per revolution with 16x microstepping?');
  assert.equal(r.style, 'simple');
  assert.match(r.answer, /3200 tiny steps/);
  assert.match(r.original_answer, /3200 microsteps per revolution/);
  assert.match(calls[0].input.messages[0].content, /9th-grade student[\s\S]*Keep EVERY fact, number/);
});

test('a rewrite that loses or changes a number is rejected; original wording returned', async () => {
  const { r } = await run('A stepper has many steps; microstepping gives lots more.', 'How many microsteps per revolution with 16x microstepping?');
  assert.equal(r.style, 'original');
  assert.match(r.simplify_skipped, /dropped or changed numbers/);
  assert.match(r.answer, /3200 microsteps per revolution/);
});

test('out of AI quota → original wording, still answered', async () => {
  const { r } = await run('x', 'How do I tune a PID controller?', { reserveGeneral: async () => ({ ok: false, reason: 'general_quota_exceeded' }) });
  assert.equal(r.answered, true);
  assert.equal(r.style, 'original');
  assert.equal(r.simplify_skipped, 'general_quota_exceeded');
});

test('general answers carry the 9th-grade instruction; style original removes it', async () => {
  let { calls } = await run('Paris.', 'What is the capital of France?');
  assert.match(calls[0].input.messages[0].content, /9th-grade reading level[\s\S]*never the content/);
  ({ calls } = await run('Paris.', 'What is the capital of France?', { style: 'original' }));
  assert.ok(!/9th-grade/.test(calls[0].input.messages[0].content));
});

test('numbersIn normalises thousands separators', () => {
  assert.deepEqual(numbersIn('$18,500 at 6.9% for 60 months, 1.8 degrees'), ['18500', '6.9', '60', '1.8']);
});
