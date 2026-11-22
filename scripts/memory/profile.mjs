// Drafts a profile skeleton from your own messages. You rewrite it by hand;
// upload refuses a profile that still contains TODO.
import { words } from './lib.mjs';

const STOP = new Set(('the a an and or but if then of to in on for with at by from is are was were be been it its this that these those ' +
  'i me my we our you your he she they them what which who how why when where can could would should will do does did have has had ' +
  'not no yes so just also about into over than more most very some any all one two get got make like use using want need know think ' +
  'please thanks thank help user assistant here there now new way time good really sure okay ok let lets give tell show explain write').split(' '));

export const MAX_PROFILE_CHARS = 1600;

export function draftProfile(chunks) {
  const df = new Map();
  for (const c of chunks) {
    const userPart = c.body.split('\nAssistant:')[0];
    for (const w of new Set(words(userPart))) {
      if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || w.startsWith('[redacted')) continue;
      df.set(w, (df.get(w) || 0) + 1);
    }
  }
  const topics = [...df.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);
  const titles = new Map();
  for (const c of chunks) titles.set(c.title, (titles.get(c.title) || 0) + 1);
  const topTitles = [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t} (${n})`);
  const dates = chunks.map((c) => c.conv_date).filter(Boolean).sort();
  const bySource = chunks.reduce((m, c) => ((m[c.source] = (m[c.source] || 0) + 1), m), {});

  return `# Profile

<!-- Draft generated from ${chunks.length} chunks (${Object.entries(bySource).map(([k, v]) => `${k}: ${v}`).join(', ')}; ${dates[0] || '?'} to ${dates.at(-1) || '?'}).
     Rewrite every section in your own words, at most ~200 words total, and delete every TODO.
     This text is sent to the model on owner requests. Do not include secrets, addresses or IDs.
     Candidate frequent topics: ${topics.join(', ') || '(none)'}
     Most-discussed chats: ${topTitles.join('; ') || '(none)'} -->

## Background
- TODO: who you are, studies or work, skill level.

## Current projects
- TODO: one line per active project and its status.

## Interests and recurring topics
- TODO

## How you like answers
- TODO: e.g. show formulas, metric units, concise.
`;
}
