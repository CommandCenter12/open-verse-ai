// Owner-only personal memory: chunks from AI chats and Google Takeout (FTS5) + a hand-written profile.
// Never call this for public keys. Errors degrade to "no memory", never to a 500.
import { contentWords } from './tokenize.js';

export const MEMORY_TOP_K = 3;
const CANDIDATES = 8;
const MAX_QUERY_WORDS = 12;
const EXCERPT_CHARS = 700;

// FTS5 query: OR of quoted words. Quoting neutralises FTS syntax (AND, NEAR, *, ", -).
export function matchQuery(question) {
  const ws = contentWords(question).slice(0, MAX_QUERY_WORDS);
  if (!ws.length) return null;
  return { query: ws.map((w) => `"${w}"`).join(' OR '), words: ws };
}

// Share of query words that appear (as a prefix, to tolerate plurals) in the chunk.
export function coverage(words, text) {
  const hay = String(text).toLowerCase();
  const hit = words.filter((w) => hay.includes(w.length > 4 ? w.slice(0, -1) : w)).length;
  return hit;
}

export async function loadMemory(db, question, log = console) {
  const result = { profile: null, chunks: [] };
  try {
    const p = await db.prepare('SELECT text FROM memory_profile WHERE id = 1').first();
    result.profile = p ? p.text : null;
    const m = matchQuery(question);
    if (m) {
      const { results } = await db
        .prepare(
          'SELECT chunk_id, title, body, source, conv_date, bm25(memory_fts, 2.0, 1.0) AS score ' +
            'FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score LIMIT ?'
        )
        .bind(m.query, CANDIDATES)
        .all();
      const need = Math.min(2, m.words.length);
      result.chunks = (results || [])
        // Title words help ranking, but relevance must come from the chunk itself:
        // otherwise every message in a matching conversation would qualify.
        .filter((r) => coverage(m.words, r.body) >= need)
        .slice(0, MEMORY_TOP_K)
        .map((r) => ({
          chunk_id: r.chunk_id,
          source: r.source,
          title: r.title,
          date: r.conv_date,
          text: r.body.length > EXCERPT_CHARS ? r.body.slice(0, EXCERPT_CHARS) + ' …' : r.body,
        }));
    }
  } catch (err) {
    log.error('memory lookup failed', err && err.message); // e.g. migration 0002 not applied
  }
  return result;
}
