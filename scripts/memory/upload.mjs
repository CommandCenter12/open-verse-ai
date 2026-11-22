#!/usr/bin/env node
// Replaces the memory tables in D1 with private/memory/chunks.jsonl + private/profile.md.
//   node scripts/memory/upload.mjs --local
//   node scripts/memory/upload.mjs --remote --yes
// Options: --chunks <path> --profile <path>
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { args, target, PRIVATE, readJsonl, runWrangler } from './lib.mjs';
import { MAX_PROFILE_CHARS } from './profile.mjs';

const opts = args();
const where = target(opts);
if (where === '--remote' && !opts.yes) {
  console.error('Uploading personal data to the live database. Re-run with --remote --yes after reviewing chunks.jsonl.');
  process.exit(1);
}
const chunksPath = opts.chunks || join(PRIVATE, 'memory', 'chunks.jsonl');
const profilePath = opts.profile || join(PRIVATE, 'profile.md');

const chunks = await readJsonl(chunksPath);
let profile;
try { profile = (await readFile(profilePath, 'utf8')).trim(); } catch {
  console.error(`Missing ${profilePath}. Copy private/profile.draft.md there and rewrite it.`);
  process.exit(1);
}
profile = profile.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
if (/\bTODO\b/.test(profile)) { console.error(`${profilePath} still contains TODO. Finish editing it first.`); process.exit(1); }
if (profile.length > MAX_PROFILE_CHARS) {
  console.error(`Profile is ${profile.length} characters; keep it under ${MAX_PROFILE_CHARS} (~200 words) so prompts stay small.`);
  process.exit(1);
}

const q = (s) => `'${String(s ?? '').replace(/\u0000/g, '').replace(/'/g, "''")}'`;
const statements = ['DELETE FROM memory_fts;'];
const MAX_STATEMENT = 80_000; // D1 limit is 100 KB per statement
let batch = [];
let size = 0;
const flush = () => {
  if (!batch.length) return;
  statements.push(`INSERT INTO memory_fts (title, body, source, conv_date, chunk_id) VALUES\n${batch.join(',\n')};`);
  batch = []; size = 0;
};
for (const c of chunks) {
  const row = `(${q(c.title)}, ${q(c.body)}, ${q(c.source)}, ${q(c.conv_date)}, ${q(c.chunk_id)})`;
  if (row.length > MAX_STATEMENT) continue;
  if (size + row.length > MAX_STATEMENT) flush();
  batch.push(row); size += row.length + 2;
}
flush();
statements.push(
  `INSERT INTO memory_profile (id, text, updated_at) VALUES (1, ${q(profile)}, ${q(new Date().toISOString())}) ` +
    'ON CONFLICT(id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at;'
);

const sqlPath = join(PRIVATE, 'memory', 'upload.sql');
await writeFile(sqlPath, statements.join('\n') + '\n');
console.log(`uploading ${chunks.length} chunks + profile (${profile.length} chars) ${where === '--remote' ? 'to the LIVE database' : 'to the local database'}…`);
runWrangler(['d1', 'execute', 'open-verse-ai', where, '--yes', `--file=${sqlPath}`], { quiet: true });
const out = runWrangler(['d1', 'execute', 'open-verse-ai', where, '--json', '--command',
  'SELECT (SELECT count(*) FROM memory_fts) AS chunks, (SELECT length(text) FROM memory_profile WHERE id = 1) AS profile_chars'], { quiet: true });
const r = JSON.parse(out.slice(out.indexOf('[')))[0].results[0];
console.log(`done: ${r.chunks} chunks, profile ${r.profile_chars} chars in D1`);
await writeFile(sqlPath, ''); // don't leave a second plaintext copy around
