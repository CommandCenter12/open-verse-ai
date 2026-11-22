// Retrieval-only Q&A: BM25 over the knowledge index, extractive answers with citations.
// It never generates text that isn't in the knowledge base.
import { tokenize } from './tokenize.js';
import { HttpError } from './http.js';

const K1 = 1.2;
const B = 0.75;
export const MIN_SCORE = 2.0;    // below this the best match is too weak to answer
export const MIN_COVERAGE = 0.5; // share of distinct query terms the best chunk must contain

export function validateQuestion(body) {
  const q = body.question;
  if (typeof q !== 'string' || !q.trim()) {
    throw new HttpError(400, 'empty_question', 'Provide a non-empty "question" string.');
  }
  const question = q.trim().replace(/\s+/g, ' ');
  if (question.length < 3) throw new HttpError(400, 'question_too_short', 'Question must be at least 3 characters.');
  if (question.length > 500) throw new HttpError(400, 'question_too_long', 'Question must be at most 500 characters.');
  let topK = 3;
  if (body.top_k !== undefined) {
    if (!Number.isInteger(body.top_k) || body.top_k < 1 || body.top_k > 5) {
      throw new HttpError(400, 'invalid_top_k', '"top_k" must be an integer from 1 to 5.');
    }
    topK = body.top_k;
  }
  return { question, topK };
}

export function search(index, queryTerms, topK) {
  const terms = [...new Set(queryTerms)];
  const scored = [];
  for (const chunk of index.chunks) {
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const tf = chunk.tf[t];
      if (!tf) continue;
      matched++;
      const df = index.df[t] || 0;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.len) / index.avgdl)));
    }
    if (score > 0) scored.push({ chunk, score, coverage: matched / terms.length });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function sentences(text) {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/))
    .map((s) => s.replace(/^[-*]\s+/, '').trim())
    .filter((s) => s.length > 0);
}

// Picks the sentences that share the most query terms, kept in original order.
export function extract(text, queryTerms, max = 3) {
  const terms = new Set(queryTerms);
  const ranked = sentences(text)
    .map((s, i) => ({ s, i, hits: new Set(tokenize(s).filter((t) => terms.has(t))).size }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i);
  return ranked.map((x) => x.s).join(' ');
}

function sourceUrl(repoUrl, chunk) {
  if (!repoUrl || repoUrl.includes('<')) return null;
  return `${repoUrl.replace(/\/$/, '')}/blob/main/knowledge/${chunk.file}#${chunk.anchor}`;
}

export function answer(index, question, topK, repoUrl) {
  const terms = tokenize(question);
  if (terms.length === 0) {
    throw new HttpError(400, 'no_searchable_terms', 'Question has no searchable words. Ask about a specific topic.');
  }
  const hits = search(index, terms, topK);
  const best = hits[0];
  if (!best || best.score < MIN_SCORE || best.coverage < MIN_COVERAGE) {
    return {
      answered: false,
      question,
      answer: null,
      message:
        "I couldn't find this in the Open Verse Ai knowledge base, so I won't guess. " +
        'Try rephrasing with specific terms, or add a document covering it to /knowledge.',
      confidence: 'none',
      sources: [],
      nearest_topics: hits.map((h) => `${h.chunk.title} › ${h.chunk.heading}`),
    };
  }
  // Keep secondary sources only if they are reasonably close to the best match.
  const usable = hits.filter((h) => h.score >= Math.max(MIN_SCORE * 0.75, best.score * 0.4));
  const text = extract(best.chunk.text, terms) || best.chunk.text.slice(0, 400);
  const confidence = best.coverage >= 0.99 && best.score >= MIN_SCORE * 2.5 ? 'high' : best.coverage >= 0.75 ? 'medium' : 'low';
  const disclaimers = [...new Set(usable.map((h) => h.chunk.disclaimer).filter(Boolean))];
  return {
    answered: true,
    question,
    answer: text,
    confidence,
    sources: usable.map((h, i) => ({
      ref: i + 1,
      title: h.chunk.title,
      section: h.chunk.heading,
      file: `knowledge/${h.chunk.file}`,
      url: sourceUrl(repoUrl, h.chunk),
      score: Math.round(h.score * 100) / 100,
      excerpt: extract(h.chunk.text, terms, 2) || h.chunk.text.slice(0, 240),
    })),
    ...(disclaimers.length ? { disclaimer: disclaimers.join(' ') } : {}),
  };
}
