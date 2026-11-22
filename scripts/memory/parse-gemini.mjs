// Google Takeout "My Activity → Gemini Apps" (choose JSON format) → normalized turns.
// MyActivity.json: [{ header, title: "Prompted <prompt>", time, products, safeHtmlItem: [{ html }] }]
// Takeout has no conversation ids, so prompts less than SESSION_GAP apart form one session.
import { isoDate, stripHtml } from './lib.mjs';

const SESSION_GAP_MS = 30 * 60 * 1000;
const PROMPT_PREFIX = /^\s*(prompted|asked|said)\s*[:  ]\s*/i;

function isGemini(e) {
  const tags = [e.header, ...(Array.isArray(e.products) ? e.products : [])].join(' ');
  return /gemini|bard/i.test(tags);
}

export function parseGemini(data) {
  if (!Array.isArray(data)) {
    throw new Error('Gemini export: expected MyActivity.json to be a JSON array. In Takeout, set "My Activity" format to JSON.');
  }
  const entries = data
    .filter((e) => e && isGemini(e) && typeof e.title === 'string' && PROMPT_PREFIX.test(e.title))
    .map((e) => ({
      ts: isoDate(e.time),
      prompt: e.title.replace(PROMPT_PREFIX, '').trim(),
      response: (Array.isArray(e.safeHtmlItem) ? e.safeHtmlItem : []).map((h) => stripHtml(h && h.html ? h.html : '')).join('\n').trim(),
    }))
    .filter((e) => e.ts && e.prompt)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const turns = [];
  let session = null;
  let lastTs = 0;
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (!session || t - lastTs > SESSION_GAP_MS) {
      session = { id: `gemini-${e.ts}`, title: e.prompt.replace(/\s+/g, ' ').slice(0, 60) };
    }
    lastTs = t;
    turns.push({ source: 'gemini', conv_id: session.id, title: session.title, ts: e.ts, role: 'user', text: e.prompt });
    if (e.response) turns.push({ source: 'gemini', conv_id: session.id, title: session.title, ts: e.ts, role: 'assistant', text: e.response });
  }
  return turns;
}
