import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAsk } from '../src/ask.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const Q = '@cf/qwen/qwen3.8-27b', L = '@cf/meta/llama-4-scout-17b-16e-instruct', G = '@cf/google/gemma-4-26b-a4b-it';
const text = (t) => ({ choices: [{ message: { content: t } }] });
const calc = (e) => ({ choices: [{ message: { content: null, tool_calls: [{ function: { name: 'calculate', arguments: JSON.stringify({ expression: e }) } }] } }] });
const ask = (AI, question) => resolveAsk({ index: INDEX, question, topK: 3, sourcesOnly: false, model: 'plus', log: { error() {} },
  env: { REPO_URL: 'x', AI }, reserveGeneral: async () => ({ ok: true }) });

test('Open Source+ asks Qwen, Llama 4 and Gemma, then combines with calculator results', async () => {
  const seen = []; let combineInput = null;
  const AI = { run: async (model, input) => {
    seen.push(model);
    const sys = input.messages[0].content;
    if (/You are Open Source\+/.test(sys)) { combineInput = input; return text('L = 1.5 kg·m²/s (2 × 0.5² × 3). Models: Qwen and Gemma agreed; Llama was corrected.'); }
    if (model === L) return text('L = 3 kg·m²/s'); // Llama is wrong
    if (input.tools) return calc('2*0.5^2*3');
    return text('L = 1.5 kg·m²/s');
  } };
  const r = await ask(AI, 'A 2 kg mass spins at 3 rad/s on a 0.5 m radius. What is its angular momentum?');
  assert.ok([Q, L, G].every((m) => seen.includes(m)), 'all three members asked');
  assert.equal(r.model, 'plus');
  assert.equal(r.combined_by, 'llama-4-scout-17b-16e-instruct');
  assert.deepEqual(r.contributors.map((c) => [c.model, c.ok]), [['qwen3.8-27b', true], ['llama-4-scout-17b-16e-instruct', true], ['gemma-4-26b-a4b-it', true]]);
  assert.equal(r.candidates.length, 3);
  assert.deepEqual(r.calculations, [{ expression: '2*0.5^2*3', result: '1.5' }]); // de-duplicated across models
  assert.match(combineInput.messages[0].content, /CALCULATOR RESULTS[\s\S]*2\*0\.5\^2\*3 = 1\.5/);
  assert.match(combineInput.messages[1].content, /ANSWER 1 \(qwen3\.8-27b\)[\s\S]*ANSWER 2 \(llama-4[\s\S]*L = 3/);
  assert.match(r.answer, /1\.5[\s\S]*Llama was corrected/);
  assert.match(r.note, /combined answers from qwen3\.8-27b, llama-4-scout-17b-16e-instruct, gemma-4-26b-a4b-it/);
});

test('one member failing still gives a combined answer; contributors show the failure', async () => {
  const AI = { run: async (model, input) => {
    if (/You are Open Source\+/.test(input.messages[0].content)) return text('Paris. Models: agreed.');
    if (model === G) throw new Error('capacity');
    return text('Paris is the capital of France.');
  } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.equal(r.answer, 'Paris. Models: agreed.');
  assert.deepEqual(r.contributors.find((c) => c.model.startsWith('gemma')), { model: 'gemma-4-26b-a4b-it', ok: false, error: 'capacity' });
});

test('only one member answers: returned as a single-model answer, clearly labelled', async () => {
  const AI = { run: async (model) => { if (model !== L) throw new Error('down'); return text('Paris.'); } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.equal(r.answer, 'Paris.');
  assert.match(r.note, /only llama-4-scout-17b-16e-instruct answered/);
});

test('combine step fails → first good answer is used, and the note says so', async () => {
  const AI = { run: async (_m, input) => { if (/You are Open Source\+/.test(input.messages[0].content)) throw new Error('combiner down'); return text('Paris.'); } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.equal(r.answer, 'Paris.');
  assert.match(r.note, /merge step failed/);
});

test('all three fail → answered:false (no crash)', async () => {
  const AI = { run: async () => { throw new Error('down'); } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.equal(r.answered, false);
  assert.equal(r.general_unavailable, 'error');
});
