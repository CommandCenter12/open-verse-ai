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

// knowledge/trading-*.md (imported trading skills) go into their own index, so their size and
// vocabulary can't change how the core docs score. qa.js searches it only for trading questions.
const all = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
const isTrading = (f) => f.startsWith('trading-');
const outTrading = join(root, 'worker', 'src', 'knowledge-trading-index.json');
const { chunks: tChunks } = await chunkFiles(all.filter(isTrading));
await writeFile(outTrading, JSON.stringify(indexOf(tChunks)));
console.log(`trading index: ${tChunks.length} chunks from ${all.filter(isTrading).length} files -> ${outTrading}`);
const files = all.filter((f) => !isTrading(f));
const { chunks } = await chunkFiles(files);

function indexOf(cs) {
  const df = {};
  for (const c of cs) for (const t of Object.keys(c.tf)) df[t] = (df[t] || 0) + 1;
  const avgdl = cs.reduce((s, c) => s + c.len, 0) / Math.max(1, cs.length);
  return { version: 1, builtAt: new Date().toISOString(), N: cs.length, avgdl, df, chunks: cs };
}

async function chunkFiles(files) {
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
return { chunks };
}

const index = indexOf(chunks);
await writeFile(out, JSON.stringify(index));
console.log(`knowledge index: ${chunks.length} chunks from ${files.length} files -> ${out}`);
