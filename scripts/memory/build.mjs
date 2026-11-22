#!/usr/bin/env node
// Local only. Parses raw exports → redacts → chunks → drafts a profile.
//   node scripts/memory/build.mjs [--exports private/exports] [--out private/memory]
// Inputs (any depth under --exports):
//   conversations.json                       Claude export
//   .../Gemini Apps/MyActivity.json          Google Takeout, "My Activity" in JSON format
import { readdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { args, PRIVATE, writeJsonl } from './lib.mjs';
import { parseClaude } from './parse-claude.mjs';
import { parseGemini } from './parse-gemini.mjs';
import { redact } from './redact.mjs';
import { chunkTurns } from './chunk.mjs';
import { draftProfile } from './profile.mjs';

const opts = args();
const exportsDir = opts.exports || join(PRIVATE, 'exports');
const outDir = opts.out || join(PRIVATE, 'memory');
const profileDraft = opts['profile-draft'] || join(outDir === join(PRIVATE, 'memory') ? PRIVATE : outDir, 'profile.draft.md');

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

const files = await walk(exportsDir);
const turns = [];
for (const f of files) {
  const rel = relative(exportsDir, f);
  if (/(^|\/)conversations\.json$/.test(f)) {
    const t = parseClaude(JSON.parse(await readFile(f, 'utf8')));
    console.log(`claude  ${rel}: ${t.length} messages`);
    turns.push(...t);
  } else if (/MyActivity\.json$/.test(f) && /gemini|bard/i.test(f)) {
    const t = parseGemini(JSON.parse(await readFile(f, 'utf8')));
    console.log(`gemini  ${rel}: ${t.length} messages`);
    turns.push(...t);
  } else if (/MyActivity\.html$/.test(f) && /gemini|bard/i.test(f)) {
    console.warn(`skip    ${rel}: HTML export. Re-export Gemini Apps activity from Takeout with format JSON.`);
  }
}
if (!turns.length) {
  console.error(`No messages found under ${exportsDir}. Expected conversations.json (Claude) or Gemini Apps/MyActivity.json (Takeout).`);
  process.exit(1);
}

const allow = await readAllow();
const totals = {};
const clean = turns.map((t) => {
  const body = redact(t.text, allow);
  const title = redact(t.title, allow);
  for (const c of [body.counts, title.counts]) for (const [k, v] of Object.entries(c)) totals[k] = (totals[k] || 0) + v;
  return { ...t, text: body.text, title: title.text };
});

const chunks = chunkTurns(clean);
await writeJsonl(join(outDir, 'turns.jsonl'), clean);
await writeJsonl(join(outDir, 'chunks.jsonl'), chunks);
const report = Object.keys(totals).length
  ? Object.entries(totals).map(([k, v]) => `${k}: ${v}`).join('\n')
  : 'nothing matched';
await writeFile(join(outDir, 'redaction-report.txt'), `Redactions (counts only, no values):\n${report}\n`);
await writeFile(profileDraft, draftProfile(chunks));

let hasProfile = true;
try { await access(join(PRIVATE, 'profile.md')); } catch { hasProfile = false; }
console.log(`\n${clean.length} messages → ${chunks.length} chunks`);
console.log(`redactions: ${report.replace(/\n/g, ', ')}`);
console.log(`wrote ${relative(process.cwd(), outDir)}/{turns,chunks}.jsonl, redaction-report.txt`);
console.log(`wrote ${relative(process.cwd(), profileDraft)}${hasProfile ? '' : '  → copy to private/profile.md and rewrite it before uploading'}`);
