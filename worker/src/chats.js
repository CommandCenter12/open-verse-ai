// Saved chats for the chat page (owner keys only): folders, chats, messages,
// multi-turn history for /v1/ask, and "same folder" memory.
import { HttpError } from './http.js';
import { redact } from './redact.js';

export const HISTORY_MESSAGES = 8;     // recent messages of this chat sent to the model
const MAX_TITLE = 80;
const MAX_FOLDER = 40;
const FOLDER_MEMORY_PAIRS = 4;        // Q&A pairs from other chats in the same folder
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

function cleanTitle(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}
export function titleFrom(question) {
  const words = cleanTitle(question).replace(/[?!.]+$/, '').split(' ').filter(Boolean);
  if (!words.length) return 'New chat';
  return words.length > 8 ? words.slice(0, 8).join(' ') + '…' : words.join(' ');
}

async function getChat(db, id) {
  const c = await db.prepare('SELECT * FROM chats WHERE id = ?').bind(id).first();
  if (!c) throw new HttpError(404, 'chat_not_found', 'No such chat.');
  return c;
}
async function folderExists(db, id) {
  if (id == null) return true;
  return Boolean(await db.prepare('SELECT id FROM folders WHERE id = ?').bind(id).first());
}
const shape = (c) => ({ id: c.id, title: c.title, folder_id: c.folder_id, pinned: Boolean(c.pinned), created_at: c.created_at, updated_at: c.updated_at });

// ---------- HTTP handlers (caller already checked owner scope) ----------
export async function handleChats(request, env, path, method, readJson) {
  const db = env.DB;
  const parts = path.split('/').filter(Boolean); // v1, chats|folders, id?

  if (parts[1] === 'folders') {
    if (parts.length === 2 && method === 'POST') {
      const body = await readJson(request);
      const name = String(body.name || '').trim().slice(0, MAX_FOLDER);
      if (!name) throw new HttpError(400, 'invalid_name', 'Folder "name" is required.');
      const f = { id: newId(), name, created_at: now() };
      await db.prepare('INSERT INTO folders (id, name, created_at) VALUES (?, ?, ?)').bind(f.id, f.name, f.created_at).run();
      return [201, f];
    }
    if (parts.length === 3 && method === 'PATCH') {
      const body = await readJson(request);
      const name = String(body.name || '').trim().slice(0, MAX_FOLDER);
      if (!name) throw new HttpError(400, 'invalid_name', 'Folder "name" is required.');
      const r = await db.prepare('UPDATE folders SET name = ? WHERE id = ? RETURNING id, name, created_at').bind(name, parts[2]).first();
      if (!r) throw new HttpError(404, 'folder_not_found', 'No such folder.');
      return [200, r];
    }
    if (parts.length === 3 && method === 'DELETE') {
      // Chats in the folder are kept and become unfiled.
      await db.prepare('UPDATE chats SET folder_id = NULL WHERE folder_id = ?').bind(parts[2]).run();
      const r = await db.prepare('DELETE FROM folders WHERE id = ? RETURNING id').bind(parts[2]).first();
      if (!r) throw new HttpError(404, 'folder_not_found', 'No such folder.');
      return [200, { deleted: true, id: parts[2] }];
    }
    throw new HttpError(405, 'method_not_allowed', 'Use POST /v1/folders, PATCH or DELETE /v1/folders/{id}.');
  }

  // /v1/chats …
  if (parts.length === 2 && method === 'GET') {
    const folders = (await db.prepare('SELECT id, name, created_at FROM folders ORDER BY name COLLATE NOCASE').all()).results || [];
    const chats = (await db.prepare('SELECT * FROM chats ORDER BY updated_at DESC LIMIT 500').all()).results || [];
    return [200, { folders, chats: chats.map(shape) }];
  }
  if (parts.length === 2 && method === 'POST') {
    const body = await readJson(request);
    const folder = body.folder_id ?? null;
    if (!(await folderExists(db, folder))) throw new HttpError(400, 'folder_not_found', 'No such folder.');
    const t = now();
    const c = { id: newId(), title: cleanTitle(body.title) || 'New chat', folder_id: folder, pinned: 0, created_at: t, updated_at: t };
    await db.prepare('INSERT INTO chats (id, title, folder_id, pinned, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind(c.id, c.title, c.folder_id, c.created_at, c.updated_at).run();
    return [201, shape(c)];
  }
  if (parts.length === 3 && method === 'GET') {
    const c = await getChat(db, parts[2]);
    const msgs = (await db.prepare('SELECT id, role, content, meta, created_at FROM chat_messages WHERE chat_id = ? ORDER BY id').bind(c.id).all()).results || [];
    return [200, { chat: shape(c), messages: msgs.map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null })) }];
  }
  if (parts.length === 3 && method === 'PATCH') {
    const c = await getChat(db, parts[2]);
    const body = await readJson(request);
    const title = body.title !== undefined ? cleanTitle(body.title) || c.title : c.title;
    const pinned = body.pinned !== undefined ? (body.pinned ? 1 : 0) : c.pinned;
    let folder = c.folder_id;
    if (body.folder_id !== undefined) {
      folder = body.folder_id;
      if (!(await folderExists(db, folder))) throw new HttpError(400, 'folder_not_found', 'No such folder.');
    }
    await db.prepare('UPDATE chats SET title = ?, pinned = ?, folder_id = ? WHERE id = ?').bind(title, pinned, folder, c.id).run();
    return [200, shape({ ...c, title, pinned, folder_id: folder })];
  }
  if (parts.length === 3 && method === 'DELETE') {
    const c = await getChat(db, parts[2]);
    await db.prepare('DELETE FROM chat_messages WHERE chat_id = ?').bind(c.id).run();
    await db.prepare('DELETE FROM chats WHERE id = ?').bind(c.id).run();
    return [200, { deleted: true, id: c.id }];
  }
  throw new HttpError(405, 'method_not_allowed', 'Unsupported chats request.');
}

// ---------- /v1/ask integration ----------
export async function chatHistory(db, chatId) {
  const c = await getChat(db, chatId);
  const rows = (await db
    .prepare('SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?')
    .bind(c.id, HISTORY_MESSAGES).all()).results || [];
  return { chat: c, history: rows.reverse().map((m) => ({ role: m.role, content: m.content.slice(0, 1500) })) };
}

export async function saveExchange(db, chat, question, result, isFirst, attachmentNames = []) {
  const t = now();
  const meta = {
    mode: result.mode, model: result.model, style: result.style, confidence: result.confidence,
    sources: result.sources, calculations: result.calculations, live_data: result.live_data,
    memory_sources: result.memory_sources, original_answer: result.original_answer,
    fallback_from: result.fallback_from, disclaimer: result.disclaimer, note: result.note,
    contributors: result.contributors, candidates: result.candidates, combined_by: result.combined_by,
  };
  await db.batch([
    db.prepare('INSERT INTO chat_messages (chat_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(chat.id, 'user', question, attachmentNames.length ? JSON.stringify({ attachments: attachmentNames }) : null, t),
    db.prepare('INSERT INTO chat_messages (chat_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(chat.id, 'assistant', String(result.answer || result.message || ''), JSON.stringify(meta), t),
    db.prepare('UPDATE chats SET updated_at = ?, title = ? WHERE id = ?')
      .bind(t, isFirst && (chat.title === 'New chat' || !chat.title) ? titleFrom(question) : chat.title, chat.id),
  ]);
}

// Recent Q&A from OTHER chats in the same folder, as memory chunks (redacted).
export async function folderMemory(db, chat) {
  if (!chat || !chat.folder_id) return [];
  const folder = await db.prepare('SELECT name FROM folders WHERE id = ?').bind(chat.folder_id).first();
  const rows = (await db.prepare(
    `SELECT c.title, c.updated_at, m.role, m.content, m.chat_id FROM chat_messages m JOIN chats c ON c.id = m.chat_id
     WHERE c.folder_id = ? AND c.id <> ? ORDER BY m.id DESC LIMIT ?`
  ).bind(chat.folder_id, chat.id, FOLDER_MEMORY_PAIRS * 2).all()).results || [];
  const pairs = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role !== 'user') continue;
    const a = rows.slice(0, i).reverse().find((x) => x.role === 'assistant' && x.chat_id === r.chat_id);
    pairs.push({
      chunk_id: `folder-${r.chat_id}-${i}`,
      source: 'folder',
      title: `${folder ? folder.name : 'Folder'} › ${r.title}`,
      date: String(r.updated_at).slice(0, 10),
      text: redact(`User: ${r.content.slice(0, 400)}\nAssistant: ${a ? a.content.slice(0, 400) : ''}`).text,
    });
  }
  return pairs.slice(-FOLDER_MEMORY_PAIRS);
}
