// Imported trading skills (knowledge/trading-*.md) answer trading questions from their own
// index, cite the MIT source file, and never change how core questions are answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answer, tradingIntent } from '../src/qa.js';
import { tokenize } from '../src/tokenize.js';

const INDEX = JSON.parse(readFileSync(new URL('../src/knowledge-index.json', import.meta.url)));
const TRADING = JSON.parse(readFileSync(new URL('../src/knowledge-trading-index.json', import.meta.url)));
const REPO = 'https://github.com/CommandCenter12/open-verse-ai';

test('trading index is separate from the core index', () => {
  assert.ok(TRADING.N > 500, 'trading skills were imported');
  assert.ok(INDEX.chunks.every((c) => !c.file.startsWith('trading-')), 'core index has no trading files');
  assert.ok(TRADING.chunks.every((c) => c.file.startsWith('trading-')));
});

test('a trading-method question is answered from a cited trading skill', () => {
  const r = answer(INDEX, 'How does the VCP screener find volatility contraction patterns?', 3, REPO);
  assert.equal(r.answered, true);
  assert.equal(r.mode, 'docs');
  assert.match(r.sources[0].file, /^knowledge\/trading-vcp-screener\.md$/);
  assert.match(r.disclaimer, /Not investment advice/);
});

test('core docs still win when they cover the question', () => {
  const r = answer(INDEX, 'What is the P/E ratio?', 3, REPO);
  assert.equal(r.answered, true);
  assert.ok(!r.sources[0].file.startsWith('knowledge/trading-'));
});

test('non-trading questions never search the trading skills', () => {
  assert.equal(tradingIntent(tokenize('What did I ask you about physics earlier?')), false);
  const r = answer(INDEX, 'How do I wire a stepper motor driver?', 3, REPO);
  assert.ok(r.sources.every((s) => !s.file.startsWith('knowledge/trading-')));
});

test('no personal skill was imported', () => {
  const text = TRADING.chunks.map((c) => c.text).join('\n');
  assert.ok(!/morning-sync|nassereddin|boukeil|@gmail\.com/i.test(text));
});
