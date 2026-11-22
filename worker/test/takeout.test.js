import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMbox, parseMessage, ownText, parseKeepNote, parseIcs, parseDriveFile, docxText } from '../../scripts/memory/parse-takeout.mjs';
import { chunkDocs, DOC_CHUNK_CHARS } from '../../scripts/memory/chunk.mjs';
import { redact } from '../src/redact.js';
import { makeDocx } from './fixtures/make-docx.mjs';

const T = new URL('./fixtures/takeout/Takeout/', import.meta.url).pathname;

test('mbox: keeps only sent mail, decodes QP/base64/encoded subjects, strips quotes and signatures', async () => {
  const { docs, seen } = await parseMbox(join(T, 'Mail/Sent.mbox'));
  assert.equal(seen, 5);
  assert.deepEqual(docs.map((d) => d.title), ['Bassinet clamp prototype update', 'Stepper motor sizing – CNC', 'RSI backtest notes']);
  const [clamp, stepper, rsi] = docs;
  assert.match(clamp.text, /holds 1\.8 N·m/);
  assert.match(clamp.text, /^From now on I'll print the jaws in PETG\.$/m); // ">From" un-escaped
  assert.ok(!/Please send the torque|Mechatronics, year 2|^Jane$/m.test(clamp.text), clamp.text); // quote + signature gone
  assert.match(stepper.text, /NEMA 23 stepper – about 1\.9 N·m holding torque/);
  assert.ok(!/iPhone|HTML version/.test(stepper.text));
  assert.match(rsi.text, /14-day lookback/);
  assert.ok(!docs.some((d) => /received email|hangouts/.test(d.text)));
  assert.equal(clamp.ts, '2026-03-12T10:00:00.000Z');
});

test('mbox: --me matches From when Gmail labels are missing', () => {
  const raw = 'From: Me <me@example.com>\nSubject: hi\nContent-Type: text/plain\n\nA message I sent from another client.';
  assert.equal(parseMessage(raw), null);
  assert.match(parseMessage(raw, { me: 'me@example.com' }).text, /another client/);
});

test('ownText drops quoted and forwarded blocks', () => {
  assert.equal(ownText('Thanks!\n\n> old\n-----Original Message-----\nFrom: x'), 'Thanks!');
});

test('keep: text and checklist notes, trashed skipped', () => {
  const read = (f) => parseKeepNote(JSON.parse(readFileSync(join(T, 'Keep', f), 'utf8')), f);
  assert.match(read('clamp-ideas.json').text, /spring-loaded jaw/);
  assert.equal(read('clamp-ideas.json').ts.slice(0, 10), '2026-03-14');
  assert.equal(read('shopping.json').text, '[x] NEMA 23 stepper motor\n[ ] TMC2209 stepper driver');
  assert.equal(read('old.json'), null);
});

test('calendar: monthly summaries, unfolded/escaped titles, no locations, cancelled dropped', () => {
  const months = parseIcs(readFileSync(join(T, 'Calendar/jane.ics'), 'utf8'));
  assert.deepEqual(months.map((m) => m.title), ['Calendar 2026-03', 'Calendar 2026-04']);
  assert.equal(months[0].text, '2026-03-16 Mechatronics lab, group B (recurring)\n2026-03-20 Control systems exam: PID and root locus revision');
  assert.ok(!/Room|Main St|Cancelled/.test(months.map((m) => m.text).join()));
});

test('drive: txt, html (no script/style), docx; pdf skipped', async () => {
  const txt = await parseDriveFile(join(T, 'Drive/School/Encoder notes.txt'));
  assert.match(txt.doc.text, /2400 counts per revolution/);
  assert.equal(txt.doc.title, 'Encoder notes');
  const html = await parseDriveFile(join(T, 'Drive/School/Portfolio plan.html'));
  assert.match(html.doc.text, /Sharpe ratio monthly/);
  assert.ok(!/alert|color:red/.test(html.doc.text));
  assert.deepEqual(await parseDriveFile(join(T, 'Drive/School/scan.pdf')), { skipped: '.pdf' });
  const dir = mkdtempSync(join(tmpdir(), 'ova-'));
  writeFileSync(join(dir, 'Clamp spec.docx'), makeDocx(['Clamp spec', 'Jaw opening 18–32 mm & silicone pad.']));
  const docx = await parseDriveFile(join(dir, 'Clamp spec.docx'));
  assert.equal(docx.doc.text, 'Clamp spec\n\nJaw opening 18–32 mm & silicone pad.');
  assert.throws(() => docxText(Buffer.from('nope')), /not a zip/);
});

test('chunkDocs: paragraph-sized chunks, short docs dropped, duplicates merged', () => {
  const para = (i) => `Section ${i}: ` + 'stepper torque note. '.repeat(30).trim();
  const long = { source: 'drive', doc_id: 'd1', title: 'Long', ts: '2026-01-02T00:00:00Z', text: [1, 2, 3, 4, 5, 6, 7, 8].map(para).join('\n\n') };
  const chunks = chunkDocs([long, { ...long, doc_id: 'd2' }, { source: 'keep', doc_id: 'k', title: 'tiny', ts: null, text: 'short' }]);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.body.length <= DOC_CHUNK_CHARS));
  assert.ok(chunks.every((c) => c.conv_id === 'd1')); // d2 identical → deduped, tiny dropped
  assert.equal(chunks[0].conv_date, '2026-01-02');
});

test('redaction still applies to email bodies', async () => {
  const { docs } = await parseMbox(join(T, 'Mail/Sent.mbox'));
  const rsi = docs.find((d) => d.title === 'RSI backtest notes');
  assert.match(rsi.text, /415-555-0199/);
  assert.ok(!redact(rsi.text).text.includes('555-0199'));
});
