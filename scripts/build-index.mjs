// Builds worker/src/knowledge-index.json from knowledge/*.md.
// Each "## " or "### " section becomes one retrievable chunk.
// Optional front matter: title, domain, disclaimer.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../worker/src/tokenize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'knowledge');
const out = join(root, 'worker', 'src', 'knowledge-index.json');

function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: src.slice(m[0].length) };
}

// GitHub-style heading anchor.
function anchor(h) {
  return h.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
const chunks = [];
for (const file of files) {
  const { meta, body } = frontMatter(await readFile(join(dir, file), 'utf8'));
  const h1 = body.match(/^# (.+)$/m);
  const title = meta.title || (h1 ? h1[1].trim() : file);
  let heading = title;
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    const tokens = tokenize(`${heading} ${heading} ${text}`); // heading weighted x2
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    chunks.push({
      id: `${file}#${anchor(heading)}`,
      file,
      anchor: anchor(heading),
      title,
      heading,
      domain: meta.domain || null,
      disclaimer: meta.disclaimer || null,
      text,
      len: tokens.length,
      tf,
    });
  };
  for (const line of body.split('\n')) {
    const h = line.match(/^#{2,3} (.+)$/);
    if (h) {
      flush();
      heading = h[1].trim();
    } else if (!/^# /.test(line)) {
      buf.push(line);
    }
  }
  flush();
}

const df = {};
for (const c of chunks) for (const t of Object.keys(c.tf)) df[t] = (df[t] || 0) + 1;
const avgdl = chunks.reduce((s, c) => s + c.len, 0) / Math.max(1, chunks.length);
const index = { version: 1, builtAt: new Date().toISOString(), N: chunks.length, avgdl, df, chunks };
await writeFile(out, JSON.stringify(index));
console.log(`knowledge index: ${chunks.length} chunks from ${files.length} files -> ${out}`);
