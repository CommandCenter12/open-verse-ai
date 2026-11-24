// Decides how /v1/ask answers a question, in this order:
//   1. math     exact arithmetic ("1+1" -> "2"), no model involved
//   2. docs     knowledge-base retrieval with citations
//   3. general  Llama on Workers AI, only if docs had nothing, the caller allowed it,
//               the question isn't about Open Verse Ai itself, and general quota remains.
//               For owner keys, the profile + top memory chunks are added as background.
//   4. none     answered:false
import { tokenize } from './tokenize.js';
import { HttpError } from './http.js';
import { answer as docsAnswer } from './qa.js';
import { tryMath } from './math.js';
import { aiConfigured, generalAnswer, isProjectQuestion, simplify } from './general.js';
import { liveIntent } from './tools.js';

const NO_DOCS_MESSAGE =
  "I couldn't find this in the Open Verse Ai knowledge base, so I won't guess. " +
  'Try rephrasing with specific terms, or add a document covering it to /knowledge.';

function notAnswered(question, extra = {}) {
  return { answered: false, mode: 'none', question, answer: null, message: NO_DOCS_MESSAGE, confidence: 'none', sources: [], nearest_topics: [], ...extra };
}

// reserveGeneral(): Promise<{ ok: true } | { ok: false, reason: string }> – consumes general quota.
// loadMemory(): Promise<{ profile, chunks }> – owner keys only; null for everyone else.
export async function resolveAsk({ index, question, topK, sourcesOnly, env, reserveGeneral, loadMemory = null, where = null, model = 'auto', style = 'simple', history = [], attachments = [], log = console }) {
  const math = tryMath(question);
  if (math) {
    if (math.error) {
      return { answered: false, mode: 'math', question, answer: null, message: math.error, confidence: 'none', sources: [] };
    }
    return {
      answered: true,
      mode: 'math',
      question,
      answer: math.result,
      expression: math.expression,
      confidence: 'exact',
      sources: [],
      note: 'Computed exactly by the Open Verse Ai calculator (no AI model).',
    };
  }

  const hasTerms = tokenize(question).length > 0;
  // Weather and market-price questions need live data, not the docs.
  const live = !sourcesOnly && aiConfigured(env) && env.TOOLS_ENABLED !== 'false' && liveIntent(question);
  // A question about an attached file is answered from the file, not the docs.
  const hasFiles = attachments.length > 0 && !sourcesOnly && aiConfigured(env);
  const docs = hasTerms && !live && !hasFiles ? docsAnswer(index, question, topK, env.REPO_URL) : notAnswered(question);
  if (docs.answered) {
    // Docs answers are exact sentences; rewrite them for a 9th grader unless style is "original".
    if (style !== 'simple' || !aiConfigured(env)) return { ...docs, style: 'original' };
    const reserved = await reserveGeneral();
    if (!reserved.ok) return { ...docs, style: 'original', simplify_skipped: reserved.reason };
    const s = await simplify(env, question, docs.answer);
    if (!s.ok) return { ...docs, style: 'original', simplify_skipped: s.reason };
    return { ...docs, answer: s.text, original_answer: docs.answer, style: 'simple', simplified_by: s.model };
  }

  const generalAllowed = !sourcesOnly && aiConfigured(env) && (hasFiles || !isProjectQuestion(question));
  if (!generalAllowed) {
    if (!hasTerms) {
      throw new HttpError(400, 'no_searchable_terms', 'Question has no searchable words. Ask about a specific topic.');
    }
    const why = sourcesOnly ? 'sources_only' : !aiConfigured(env) ? 'disabled' : 'project_question';
    return { ...docs, general_unavailable: why };
  }

  const reserved = await reserveGeneral();
  if (!reserved.ok) return { ...docs, general_unavailable: reserved.reason };

  const memory = loadMemory ? await loadMemory() : null;
  try {
    const extra = style === 'original' ? { styleOverride: 'Write in your normal style.' } : {};
    return { ...(await generalAnswer(env, question, memory, { where, model, history, attachments, ...extra })), style, nearest_topics: docs.nearest_topics };
  } catch (err) {
    log.error('general answer failed', err && err.message);
    if (err && err.code === 'ai_daily_limit') {
      const next = new Date(); next.setUTCHours(24, 0, 0, 0);
      return {
        ...docs,
        general_unavailable: 'ai_daily_limit',
        ai_resets_at: next.toISOString(),
        message: "Today's free AI allowance (Cloudflare Workers AI) is used up, so AI answers are paused until it resets at 00:00 UTC. " +
          'Answers from the docs and plain math (like 12*12) still work.',
      };
    }
    return { ...docs, general_unavailable: 'error' };
  }
}
