// Normalized turns → retrieval chunks: one user message + the reply that followed.
import { createHash } from 'node:crypto';
import { words } from './lib.mjs';

export const MAX_USER_CHARS = 1200;
export const MAX_ASSISTANT_CHARS = 600;
const MIN_USER_WORDS = 4; // drops "thanks", "ok continue", ...

function clip(text, max) {
  const t = text.replace(/\s+\n/g, '\n').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return (end > max * 0.6 ? cut.slice(0, end + 1) : cut) + ' …';
}

export function chunkTurns(turns) {
  // Exact duplicate messages (same chat exported twice, retried sends) would
  // otherwise split a user message from its reply.
  const unique = new Map();
  for (const t of turns) unique.set(`${t.source}|${t.conv_id}|${t.role}|${t.ts}|${t.text}`, t);
  const byConv = new Map();
  for (const t of unique.values()) {
    const k = `${t.source}:${t.conv_id}`;
    if (!byConv.has(k)) byConv.set(k, []);
    byConv.get(k).push(t);
  }
  const chunks = [];
  const seen = new Set();
  for (const list of byConv.values()) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (u.role !== 'user') continue;
      if (words(u.text).length < MIN_USER_WORDS) continue;
      const replies = [];
      for (let j = i + 1; j < list.length && list[j].role === 'assistant'; j++) replies.push(list[j].text);
      const key = u.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      const user = clip(u.text, MAX_USER_CHARS);
      const reply = replies.length ? clip(replies.join('\n'), MAX_ASSISTANT_CHARS) : '';
      const id = createHash('sha256').update(`${u.source}|${u.conv_id}|${u.ts}|${key}`).digest('hex').slice(0, 16);
      chunks.push({
        chunk_id: id,
        source: u.source,
        conv_id: u.conv_id,
        title: u.title,
        conv_date: u.ts ? u.ts.slice(0, 10) : '',
        body: reply ? `User: ${user}\nAssistant: ${reply}` : `User: ${user}`,
      });
    }
  }
  return chunks.sort((a, b) => a.conv_date.localeCompare(b.conv_date));
}

// Documents (Drive, Gmail, Keep, Calendar) → ~900-char chunks on paragraph boundaries.
export const DOC_CHUNK_CHARS = 900;
const MAX_CHUNKS_PER_DOC = 30;
const MIN_DOC_CHARS = 40;

export function chunkDocs(docs) {
  const chunks = [];
  const seen = new Set();
  for (const d of docs) {
    const text = String(d.text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
    if (text.length < (d.source === 'calendar' ? 10 : MIN_DOC_CHARS)) continue; // one-event months are still useful
    const paras = text.split(/\n\s*\n/).flatMap((p) =>
      p.length <= DOC_CHUNK_CHARS ? [p] : p.match(new RegExp(`[\\s\\S]{1,${DOC_CHUNK_CHARS}}(?=\\s|$)`, 'g')) || [p]
    );
    let buf = '';
    let n = 0;
    const push = () => {
      const body = buf.trim();
      buf = '';
      if (!body || n >= MAX_CHUNKS_PER_DOC) return;
      const key = body.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return;
      seen.add(key);
      chunks.push({
        chunk_id: createHash('sha256').update(`${d.source}|${d.doc_id}|${n}`).digest('hex').slice(0, 16),
        source: d.source,
        conv_id: d.doc_id,
        title: d.title,
        conv_date: d.ts ? String(d.ts).slice(0, 10) : '',
        body,
      });
      n++;
    };
    for (const p of paras) {
      if (buf && buf.length + p.length + 2 > DOC_CHUNK_CHARS) push();
      buf += (buf ? '\n\n' : '') + p.trim();
    }
    push();
  }
  return chunks;
}
