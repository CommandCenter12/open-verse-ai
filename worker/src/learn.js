// Memory that learns (owner keys only):
//   "remember that …" / "from now on …"   → saved facts, always given to the model
//   "no, actually …" / "that's wrong, …"   → saved corrections
//   "forget …" / "what do you remember?"   → manage facts
//   every answered question                 → saved as a searchable past conversation
import { redact } from './redact.js';
import { tokenize } from './tokenize.js';

const MAX_FACT_CHARS = 500;
const MAX_FACTS = 200;
const FACTS_IN_PROMPT_CHARS = 1800;
export const LEARNED_SOURCE = 'openverse';
export const MAX_LEARNED_CONVERSATIONS = 5000;

const REMEMBER = /^\s*(?:please\s+)?(?:remember|keep in mind)(?:\s+that)?\s*[:,-]?\s+(.{3,})$/is;
const FROM_NOW_ON = /^\s*(?:from now on|always|never)\b[,:]?\s+(.{3,})$/is;
const FORGET_ALL = /^\s*(?:please\s+)?forget\s+(?:everything|all)(?:\s+(?:you(?:'ve| have)?\s+learned|about me))?[.!]?\s*$/i;
const FORGET = /^\s*(?:please\s+)?forget(?:\s+(?:that|about))?\s*[:,-]?\s+(.{2,})$/is;
const CORRECTION = /^\s*(?:no|nope|wrong|incorrect|that'?s (?:wrong|not right|incorrect|not true)|actually)\b[,.!:]?\s+(.{3,})$/is;
const LIST = /^\s*what (?:do you|did you) (?:remember|know|learn(?:ed)?) about me\s*\??\s*$/i;

export function parseCommand(question) {
  const q = question.trim();
  if (LIST.test(q)) return { kind: 'list' };
  if (FORGET_ALL.test(q)) return { kind: 'forget_all' };
  let m;
  if ((m = q.match(FORGET))) return { kind: 'forget', text: m[1].trim().replace(/[.!]+$/, '') };
  if ((m = q.match(REMEMBER))) return { kind: 'remember', fact: 'fact', text: m[1].trim() };
  if ((m = q.match(FROM_NOW_ON)) && !q.endsWith('?')) return { kind: 'remember', fact: 'preference', text: q };
  if ((m = q.match(CORRECTION)) && !q.endsWith('?')) return { kind: 'remember', fact: 'correction', text: m[1].trim() };
  return null;
}

const reply = (question, answer, extra = {}) => ({ answered: true, mode: 'memory', question, answer, confidence: 'exact', sources: [], ...extra });

export async function handleCommand(db, cmd, question) {
  if (cmd.kind === 'list') {
    const { results } = await db.prepare('SELECT id, kind, text, created_at FROM memory_facts ORDER BY id DESC LIMIT 50').all();
    const facts = results || [];
    return reply(question, facts.length
      ? `Here's what you've told me to remember (${facts.length}):\n` + facts.map((f) => `- ${f.kind === 'fact' ? '' : f.kind + ': '}${f.text}`).join('\n')
      : "You haven't told me to remember anything yet. Say \"remember that …\" to teach me.", { memory_action: { action: 'list', facts } });
  }
  if (cmd.kind === 'forget_all') {
    const f = await db.prepare('DELETE FROM memory_facts RETURNING id').all();
    // FTS5 tables don't support DELETE … RETURNING: count, then delete.
    const nc = (await db.prepare('SELECT count(*) AS n FROM memory_fts WHERE source = ?').bind(LEARNED_SOURCE).first()).n;
    await db.prepare('DELETE FROM memory_fts WHERE source = ?').bind(LEARNED_SOURCE).run();
    const nf = (f.results || []).length;
    return reply(question, `Done. I forgot ${nf} saved fact${nf === 1 ? '' : 's'} and ${nc} past conversation${nc === 1 ? '' : 's'}. Your imported chats and Google data are untouched.`,
      { memory_action: { action: 'forget_all', facts: nf, conversations: nc } });
  }
  if (cmd.kind === 'forget') {
    // Word match, not exact phrase: "forget that I take Algebra 2" finds "… taking AP Physics and Algebra 2".
    const want = [...new Set(tokenize(cmd.text))];
    const { results: all } = await db.prepare('SELECT id, text FROM memory_facts').all();
    const gone = want.length ? (all || []).filter((f) => { const have = new Set(tokenize(f.text)); return want.every((w) => have.has(w)); }) : [];
    for (const g of gone) await db.prepare('DELETE FROM memory_facts WHERE id = ?').bind(g.id).run();
    return reply(question, gone.length
      ? `Forgotten (whole saved fact${gone.length > 1 ? 's' : ''}; re-add anything you still want with "remember that …"):\n${gone.map((g) => `- ${g.text}`).join('\n')}`
      : `I don't have a saved fact containing "${cmd.text}". Say "what do you remember about me?" to see them.`,
      { memory_action: { action: 'forget', removed: gone.map((g) => g.id) } });
  }
  // remember / preference / correction
  const clean = redact(cmd.text).text.slice(0, MAX_FACT_CHARS);
  const count = (await db.prepare('SELECT count(*) AS n FROM memory_facts').first()).n;
  if (count >= MAX_FACTS) {
    return reply(question, `I already have ${MAX_FACTS} saved facts. Ask me to forget some first.`, { memory_action: { action: 'full' } });
  }
  let context = null;
  if (cmd.fact === 'correction') {
    const last = await db.prepare('SELECT title FROM memory_fts WHERE source = ? ORDER BY rowid DESC LIMIT 1').bind(LEARNED_SOURCE).first();
    context = last ? last.title : null;
  }
  const row = await db
    .prepare('INSERT INTO memory_facts (kind, text, context, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(cmd.fact, clean, context, new Date().toISOString())
    .first();
  const said = { fact: "Got it, I'll remember", preference: "Got it, from now on I'll keep that in mind", correction: "Thanks for the correction, I've saved it" }[cmd.fact];
  return reply(question, `${said}: "${clean}"`, { memory_action: { action: 'remember', kind: cmd.fact, id: row.id, ...(context ? { corrects: context } : {}) } });
}

// Saves a Q&A so later questions can find it. Skips time-sensitive live data, questions about
// past conversations (saving those makes memory quote itself) and answers that admit not knowing.
const ABOUT_PAST = /\b(earlier|before|last time|previously|yesterday|we talked|did i ask|i asked|remind me|remember about me|our (last )?(chat|conversation))\b/i;
const NON_ANSWER = /^\s*(i don'?t (have|know)|i am not sure|i'm not sure|i couldn'?t|sorry)\b/i;
export function shouldLearn(result) {
  if (!result || !result.answered || !(result.mode === 'general' || result.mode === 'docs')) return false;
  if (ABOUT_PAST.test(result.question || '')) return false;
  if (NON_ANSWER.test(String(result.answer || '')) && String(result.answer).length < 200) return false;
  return true;
}

export async function saveConversation(db, question, result) {
  const q = redact(question).text;
  const a = redact(String(result.answer || '')).text.slice(0, 600);
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await db
    .prepare('INSERT INTO memory_fts (title, body, source, conv_date, chunk_id) VALUES (?, ?, ?, ?, ?)')
    .bind(q.slice(0, 80), `User: ${q}\nAssistant: ${a}`, LEARNED_SOURCE, new Date().toISOString().slice(0, 10), id)
    .run();
}

export async function loadFacts(db) {
  const { results } = await db.prepare('SELECT kind, text, context FROM memory_facts ORDER BY id DESC LIMIT 100').all();
  const out = [];
  let size = 0;
  for (const f of results || []) {
    size += f.text.length + 20;
    if (size > FACTS_IN_PROMPT_CHARS) break;
    out.push(f);
  }
  return out;
}

export async function pruneLearned(db) {
  await db
    .prepare(
      'DELETE FROM memory_fts WHERE source = ? AND rowid NOT IN (SELECT rowid FROM memory_fts WHERE source = ? ORDER BY rowid DESC LIMIT ?)'
    )
    .bind(LEARNED_SOURCE, LEARNED_SOURCE, MAX_LEARNED_CONVERSATIONS)
    .run();
}
