#!/usr/bin/env node
// Local only. Parses raw exports → redacts → chunks → drafts a profile.
//   node scripts/memory/build.mjs [--exports private/exports] [--out private/memory]
//                                 [--sources claude,gemini,drive,gmail,keep,calendar] [--me you@gmail.com]
// Recognised inputs (any depth under --exports):
//   conversations.json                    Claude export
//   .../Gemini Apps/MyActivity.json       Takeout, My Activity in JSON format
//   .../Drive/**.{txt,md,html,htm,docx}   Takeout Drive
//   .../Mail/*.mbox                       Takeout Gmail (only SENT messages are kept)
//   .../Keep/*.json                       Takeout Keep
//   .../Calendar/*.ics                    Takeout Calendar
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { args, PRIVATE, writeJsonl } from './lib.mjs';
import { parseClaude } from './parse-claude.mjs';
import { parseGemini } from './parse-gemini.mjs';
import { parseDriveFile, parseMbox, parseKeepNote, parseIcs } from './parse-takeout.mjs';
import { redact } from './redact.mjs';
import { chunkTurns, chunkDocs } from './chunk.mjs';
import { draftProfile } from './profile.mjs';

const ALL = ['claude', 'gemini', 'drive', 'gmail', 'keep', 'calendar'];
const opts = args();
const exportsDir = opts.exports || join(PRIVATE, 'exports');
const outDir = opts.out || join(PRIVATE, 'memory');
const profileDraft = opts['profile-draft'] || join(outDir === join(PRIVATE, 'memory') ? PRIVATE : outDir, 'profile.draft.md');
const sources = new Set(opts.sources ? String(opts.sources).split(',').map((s) => s.trim()) : ALL);
for (const s of sources) if (!ALL.includes(s)) { console.error(`Unknown source "${s}". Use: ${ALL.join(', ')}`); process.exit(1); }
const me = typeof opts.me === 'string' ? opts.me : null;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function readAllow() {
  try {
    return (await readFile(join(PRIVATE, 'redact-allow.txt'), 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
}

const inDir = (f, name) => f.split(sep).some((part) => part.toLowerCase() === name);
const turns = [];
const docs = [];
const stats = {};
const skipped = {};
const count = (k, n) => (stats[k] = (stats[k] || 0) + n);

for (const f of await walk(exportsDir)) {
  const rel = relative(exportsDir, f);
  try {
    if (/(^|[\\/])conversations\.json$/.test(f)) {
      if (!sources.has('claude')) continue;
      const t = parseClaude(JSON.parse(await readFile(f, 'utf8')));
      turns.push(...t); count('claude messages', t.length);
    } else if (/MyActivity\.json$/.test(f) && /gemini|bard/i.test(f)) {
      if (!sources.has('gemini')) continue;
      const t = parseGemini(JSON.parse(await readFile(f, 'utf8')));
      turns.push(...t); count('gemini messages', t.length);
    } else if (/MyActivity\.html$/.test(f) && /gemini|bard/i.test(f)) {
      console.warn(`skip    ${rel}: HTML export. Re-export Gemini Apps activity from Takeout with format JSON.`);
    } else if (f.endsWith('.mbox')) {
      if (!sources.has('gmail')) continue;
      process.stdout.write(`gmail   ${rel}: reading… `);
      const { docs: d, seen } = await parseMbox(f, { me });
      console.log(`${seen} messages, ${d.length} sent by you`);
      docs.push(...d); count('gmail sent emails', d.length);
    } else if (inDir(f, 'keep') && f.endsWith('.json')) {
      if (!sources.has('keep')) continue;
      const d = parseKeepNote(JSON.parse(await readFile(f, 'utf8')), f);
      if (d) { docs.push(d); count('keep notes', 1); }
    } else if (f.toLowerCase().endsWith('.ics')) {
      if (!sources.has('calendar')) continue;
      const d = parseIcs(await readFile(f, 'utf8'));
      docs.push(...d); count('calendar months', d.length);
    } else if (inDir(f, 'drive')) {
      if (!sources.has('drive')) continue;
      const r = await parseDriveFile(f);
      if (r.doc) { docs.push(r.doc); count('drive files', 1); }
      else skipped[`drive ${r.skipped}`] = (skipped[`drive ${r.skipped}`] || 0) + 1;
    }
  } catch (err) {
    console.warn(`skip    ${rel}: ${err.message}`);
    skipped['unreadable'] = (skipped['unreadable'] || 0) + 1;
  }
}

if (!turns.length && !docs.length) {
  console.error(`Nothing usable found under ${exportsDir} for sources: ${[...sources].join(', ')}.`);
  process.exit(1);
}

const allow = await readAllow();
const totals = {};
const clean = (x, field) => {
  const r = redact(x[field] || '', allow);
  for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] || 0) + v;
  return r.text;
};
const cleanTurns = turns.map((t) => ({ ...t, text: clean(t, 'text'), title: clean(t, 'title') }));
const cleanDocs = docs.map((d) => ({ ...d, text: clean(d, 'text'), title: clean(d, 'title') }));

const chunks = [...chunkTurns(cleanTurns), ...chunkDocs(cleanDocs)].sort((a, b) => a.conv_date.localeCompare(b.conv_date));
await writeJsonl(join(outDir, 'turns.jsonl'), cleanTurns);
await writeJsonl(join(outDir, 'docs.jsonl'), cleanDocs);
await writeJsonl(join(outDir, 'chunks.jsonl'), chunks);
const report = Object.keys(totals).length ? Object.entries(totals).map(([k, v]) => `${k}: ${v}`).join('\n') : 'nothing matched';
await writeFile(join(outDir, 'redaction-report.txt'), `Redactions (counts only, no values):\n${report}\n`);
await writeFile(profileDraft, draftProfile(chunks));

const bySource = chunks.reduce((m, c) => ((m[c.source] = (m[c.source] || 0) + 1), m), {});
let hasProfile = true;
try { await access(join(PRIVATE, 'profile.md')); } catch { hasProfile = false; }
console.log('\nfound:   ' + (Object.entries(stats).map(([k, v]) => `${v} ${k}`).join(', ') || 'nothing'));
if (Object.keys(skipped).length) console.log('skipped: ' + Object.entries(skipped).map(([k, v]) => `${v} ${k}`).join(', '));
console.log(`chunks:  ${chunks.length} (${Object.entries(bySource).map(([k, v]) => `${k} ${v}`).join(', ')})`);
console.log(`redacted: ${report.replace(/\n/g, ', ')}`);
console.log(`wrote ${relative(process.cwd(), outDir)}/{turns,docs,chunks}.jsonl, redaction-report.txt`);
console.log(`wrote ${relative(process.cwd(), profileDraft)}${hasProfile ? '' : '  → copy to private/profile.md and rewrite it before uploading'}`);
