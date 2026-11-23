// Knowledge-base Q&A: BM25 over the knowledge index, extractive answers with citations.
// It never generates text that isn't in the knowledge base.
import { tokenize } from './tokenize.js';
import { HttpError } from './http.js';

// Words that name the project: present in many API chunks, so they make any question
// "about Open Verse Ai" look covered. Ignored by the weighted-coverage check.
const PROJECT_TERMS = new Set(tokenize('open verse ai api v1'));
// Generic question words. If the docs never use one, that alone shouldn't block an answer
// ("How is RSI calculated?" is answered by the RSI section).
const WEAK_TERMS = new Set(tokenize(
  'calculate calculated calculation compute computed work works working use used using happen happens mean means ' +
  'find get make need explain example formula difference between best good quickly quick easy simple step steps way ways ' +
  'value values number numbers typical usually exactly correct right determine figure choose pick many much'
));

const K1 = 1.2;
const B = 0.75;
export const MIN_SCORE = 2.0;    // below this the best match is too weak to answer
export const MIN_COVERAGE = 0.5; // share of distinct query terms the best chunk must contain
// Same, but each term weighted by rarity (IDF; words absent from the docs count as rarest).
// Stops "Does X have a /v1/translate endpoint?" matching on the common words while the
// one word that matters ("translate") appears nowhere.
export const MIN_WEIGHTED_COVERAGE = 0.55; // > half: a borderline half-match (e.g. 'square root' in Volatility) is not an answer

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
  let sourcesOnly = false;
  if (body.sources_only !== undefined) {
    if (typeof body.sources_only !== 'boolean') {
      throw new HttpError(400, 'invalid_sources_only', '"sources_only" must be true or false.');
    }
    sourcesOnly = body.sources_only;
  }
  let model = 'auto';
  if (body.model !== undefined) {
    const ok = ['auto', 'qwen', 'gemma', 'llama4', 'llama', 'mistral'];
    if (typeof body.model !== 'string' || !ok.includes(body.model)) {
      throw new HttpError(400, 'invalid_model', `"model" must be one of: ${ok.join(', ')}.`);
    }
    model = body.model;
  }
  let style = 'simple';
  if (body.style !== undefined) {
    if (body.style !== 'simple' && body.style !== 'original') throw new HttpError(400, 'invalid_style', '"style" must be "simple" or "original".');
    style = body.style;
  }
  let useMemory = true;
  if (body.use_memory !== undefined) {
    if (typeof body.use_memory !== 'boolean') {
      throw new HttpError(400, 'invalid_use_memory', '"use_memory" must be true or false.');
    }
    useMemory = body.use_memory;
  }
  return { question, topK, sourcesOnly, useMemory, model, style };
}

export function search(index, queryTerms, topK) {
  // Generic words ("work", "get") only count when the question has nothing else.
  const unique = [...new Set(queryTerms)];
  const strong = unique.filter((t) => !WEAK_TERMS.has(t));
  const terms = strong.length ? strong : unique;
  const idfOf = (t) => {
    const df = index.df[t] || 0;
    return Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
  };
  const counted = terms.filter((t) => !PROJECT_TERMS.has(t));
  const totalIdf = counted.reduce((s, t) => s + idfOf(t), 0);
  const scored = [];
  for (const chunk of index.chunks) {
    let score = 0;
    let matched = 0;
    let matchedIdf = 0;
    for (const t of terms) {
      const tf = chunk.tf[t];
      if (!tf) continue;
      matched++;
      const idf = idfOf(t);
      if (counted.includes(t)) matchedIdf += idf;
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * chunk.len) / index.avgdl)));
    }
    if (score > 0) scored.push({ chunk, score, coverage: matched / terms.length, weighted: totalIdf ? matchedIdf / totalIdf : 1 });
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
  // Bare numbers ("1 1") would match stray digits in the docs; never treat that as grounded.
  const hits = terms.every((t) => /^\d+$/.test(t)) ? [] : search(index, terms, topK);
  const best = hits[0];
  if (!best || best.score < MIN_SCORE || best.coverage < MIN_COVERAGE || best.weighted < MIN_WEIGHTED_COVERAGE) {
    return {
      answered: false,
      mode: 'none',
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
    mode: 'docs',
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
