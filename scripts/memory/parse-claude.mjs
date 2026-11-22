// Claude export (Settings → Privacy → Export data) → normalized turns.
// conversations.json: [{ uuid, name, created_at, chat_messages: [{ sender, text, content, created_at }] }]
import { isoDate } from './lib.mjs';

function messageText(m) {
  if (typeof m.text === 'string' && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  }
  return '';
}

export function parseClaude(data) {
  if (!Array.isArray(data)) throw new Error('Claude export: expected conversations.json to be a JSON array.');
  const turns = [];
  for (const conv of data) {
    if (!conv || !Array.isArray(conv.chat_messages)) continue;
    const convId = String(conv.uuid || conv.id || '');
    const title = String(conv.name || '').trim() || 'Untitled Claude chat';
    for (const m of conv.chat_messages) {
      const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
      const text = messageText(m).trim();
      if (!role || !text) continue;
      turns.push({ source: 'claude', conv_id: convId, title, ts: isoDate(m.created_at || conv.created_at), role, text });
    }
  }
  return turns;
}
