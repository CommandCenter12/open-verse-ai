import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAsk } from '../src/ask.js';
import { textOf, plainMath } from '../src/general.js';
import { numericIntent } from '../src/tools.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const ask = (AI, question, env = {}) => resolveAsk({
  index: INDEX, question, topK: 3, sourcesOnly: false, log: { error() {} },
  env: { REPO_URL: 'x', AI, ...env }, reserveGeneral: async () => ({ ok: true }),
});
// Qwen on Workers AI answers in OpenAI style: { choices: [{ message: { content, tool_calls } }] }
const qwenCall = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const qwenText = (content) => ({ choices: [{ message: { content } }] });

test('Qwen calculates with the exact calculator, then answers from the results', async () => {
  const calls = [];
  const AI = { run: async (model, input) => {
    calls.push({ model, input });
    if (calls.length === 1) return qwenCall('calculate', { expression: '18500*(0.069/12)/(1-(1+0.069/12)^-60)' });
    return qwenText('The monthly payment is about \\$365.45 \\(\\text{per month}\\).');
  } };
  const r = await ask(AI, 'A car loan is $18,500 at 6.9% APR for 60 months. What is the monthly payment?');
  assert.equal(r.mode, 'general');
  assert.equal(calls[0].model, '@cf/qwen/qwen3.8-27b');
  assert.ok(calls[0].input.tools.some((t) => t.name === 'calculate'));
  assert.deepEqual(r.calculations, [{ expression: '18500*(0.069/12)/(1-(1+0.069/12)^-60)', result: '365.44996884' }]);
  assert.match(calls[1].input.messages[0].content, /CALCULATOR RESULTS[\s\S]*= 365\.44996884/);
  assert.equal(r.confidence, 'calculated');
  assert.equal(r.answer, 'The monthly payment is about $365.45 per month.');
});

test('multi-round calculations stop after 3 rounds', async () => {
  let n = 0;
  const AI = { run: async (_m, input) => { n++; return input.tools ? qwenCall('calculate', { expression: `${n}*2` }) : qwenText('done'); } };
  const r = await ask(AI, 'What is 2 times 3 then times 4 then times 5?');
  assert.equal(n, 4); // 3 tool rounds + 1 final answer without tools
  assert.equal(r.calculations.length, 3);
});

test('calculator errors are passed to the model, not hidden', async () => {
  const calls = [];
  const AI = { run: async (_m, input) => { calls.push(input); return calls.length === 1 ? qwenCall('calculate', { expression: 'sqrt(-4)' }) : qwenText('There is no real solution.'); } };
  const r = await ask(AI, 'What is the square root of -4 in real numbers?');
  assert.match(r.calculations[0].error, /not a real number/);
  assert.match(calls[1].messages[0].content, /sqrt\(-4\) = ERROR/);
  assert.equal(r.confidence, 'unverified');
});

test('falls back in tested order (Qwen → Gemma → Llama 4) and says so', async () => {
  const models = [];
  const AI = { run: async (model) => { models.push(model); if (!model.includes('llama-4')) throw new Error('capacity'); return { response: 'Paris is the capital of France.' }; } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.deepEqual(models, ['@cf/qwen/qwen3.8-27b', '@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-4-scout-17b-16e-instruct']);
  assert.equal(r.model, 'llama-4-scout-17b-16e-instruct');
  assert.equal(r.fallback_from, 'qwen3.8-27b');
  assert.match(r.fallback_reason, /qwen3\.8-27b: capacity; gemma-4-26b-a4b-it: capacity/);
});

test('at most 3 models are tried, then a clear failure', async () => {
  const models = [];
  const AI = { run: async (model) => { models.push(model); throw new Error('down'); } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.equal(models.length, 3);
  assert.equal(r.answered, false);
  assert.equal(r.general_unavailable, 'error');
});

test('a chosen model goes first; AI_FALLBACK_MODEL none disables fallbacks', async () => {
  const { modelChain } = await import('../src/general.js');
  assert.deepEqual(modelChain({}, 'gemma'), ['@cf/google/gemma-4-26b-a4b-it', '@cf/qwen/qwen3.8-27b', '@cf/meta/llama-4-scout-17b-16e-instruct']);
  assert.deepEqual(modelChain({}, 'mistral')[0], '@cf/mistralai/mistral-small-3.1-24b-instruct');
  assert.deepEqual(modelChain({ AI_FALLBACK_MODEL: 'none' }, 'auto'), ['@cf/qwen/qwen3.8-27b']);
  const { validateQuestion } = await import('../src/qa.js');
  assert.equal(validateQuestion({ question: 'hello there', model: 'llama4' }).model, 'llama4');
  assert.throws(() => validateQuestion({ question: 'hello there', model: 'gpt-5' }), { code: 'invalid_model' });
});

test('no calculator offered for questions without numbers', async () => {
  const calls = [];
  const AI = { run: async (_m, input) => { calls.push(input); return qwenText('Paris.'); } };
  await ask(AI, 'What is the capital of France?');
  assert.equal(calls[0].tools, undefined);
  assert.equal(numericIntent('how much torque does it need'), true);
  assert.equal(numericIntent('Who wrote Hamlet'), false);
});

test('textOf reads both formats, strips <think> and LaTeX', () => {
  assert.equal(textOf({ response: 'hi' }), 'hi');
  assert.equal(textOf(qwenText('<think>secret reasoning</think>Answer: 4')), 'Answer: 4');
  assert.equal(plainMath('\\[ L = 2 \\times 0.5^2 \\times 3 = 1.5 \\]'), ' L = 2 × 0.5^2 × 3 = 1.5 ');
  assert.equal(plainMath('\\frac{84}{0.70} = 120 \\text{ dollars}'), '(84)/(0.70) = 120  dollars');
});

test('a model that repeats a calculation or goes quiet gets one final call without tools', async () => {
  const calls = [];
  const AI = { run: async (_m, input) => {
    calls.push(input);
    if (calls.length === 1) return qwenCall('calculate', { expression: '2 * 0.5^2 * 3' });
    if (input.tools) return { choices: [{ message: { content: null, reasoning_content: 'thinking…' } }] }; // Gemma-style silence
    return qwenText('L = 1.5 kg·m²/s');
  } };
  const r = await ask(AI, 'A 2 kg mass spins at 3 rad/s on a 0.5 m radius. What is its angular momentum?');
  assert.equal(r.answer, 'L = 1.5 kg·m²/s');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].tools, undefined);

  const calls2 = [];
  const AI2 = { run: async (_m, input) => { calls2.push(input); return input.tools ? qwenCall('calculate', { expression: '2*0.5**2*3' }) : qwenText('1.5'); } };
  const r2 = await ask(AI2, 'What is 2 times 0.5 squared times 3?');
  assert.equal(r2.calculations.length, 1); // the repeat (written with **) was recognised
  assert.equal(r2.answer, '1.5');
});

test('Gemma gets reasoning_effort low; other models are unchanged', async () => {
  const seen = [];
  const AI = { run: async (model, input) => { seen.push([model, input.reasoning_effort]); return { choices: [{ message: { content: 'Paris.' } }] }; } };
  await ask(AI, 'What is the capital of France?', {});
  await resolveAsk({ index: INDEX, question: 'What is the capital of France?', topK: 3, sourcesOnly: false, model: 'gemma', log: { error() {} }, env: { REPO_URL: 'x', AI }, reserveGeneral: async () => ({ ok: true }) });
  assert.deepEqual(seen, [['@cf/qwen/qwen3.8-27b', undefined], ['@cf/google/gemma-4-26b-a4b-it', 'low']]);
});

test('daily Workers AI limit (4006) → clear message, stops after the first model', async () => {
  const models = [];
  const AI = { run: async (model) => { models.push(model); throw new Error('4006: you have used up your daily free allocation of 10,000 neurons'); } };
  const r = await ask(AI, 'What is the capital of France?');
  assert.equal(models.length, 1); // account-wide limit: no point trying the backups
  assert.equal(r.answered, false);
  assert.equal(r.general_unavailable, 'ai_daily_limit');
  assert.match(r.message, /free AI allowance[\s\S]*resets at 00:00 UTC/);
  assert.match(r.ai_resets_at, /T00:00:00\.000Z$/);
  const plus = await resolveAsk({ index: INDEX, question: 'What is the capital of France?', topK: 3, sourcesOnly: false, model: 'plus', log: { error() {} }, env: { REPO_URL: 'x', AI }, reserveGeneral: async () => ({ ok: true }) });
  assert.equal(plus.general_unavailable, 'ai_daily_limit');
});
