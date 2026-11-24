import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/d1.mjs';
import worker from '../src/index.js';
import { generateKey, sha256Hex } from '../src/keys.js';
import { titleFrom } from '../src/chats.js';

function setup() {
  const DB = d1();
  const prompts = [];
  const AI = { run: async (_m, input) => { prompts.push(input.messages); return { choices: [{ message: { content: `Answer #${prompts.length}` } }] }; } };
  const env = { DB, AI, IP_SALT: 't', REPO_URL: 'x', ALLOWED_ORIGINS: '' };
  const pending = [];
  const call = async (key, method, path, body) => {
    const res = await worker.fetch(new Request('http://api.test' + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: body ? JSON.stringify(body) : undefined,
    }), env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending.splice(0));
    return { status: res.status, body: await res.json() };
  };
  return { DB, prompts, call };
}
async function key(DB, scope) {
  const k = generateKey();
  DB.raw.prepare('INSERT INTO api_keys (key_hash, prefix, created_at, scope) VALUES (?, ?, ?, ?)').run(await sha256Hex(k), k.slice(0, 12), new Date().toISOString(), scope);
  return k;
}

test('public keys cannot use saved chats', async () => {
  const { DB, call } = setup();
  const pub = await key(DB, 'public');
  assert.equal((await call(pub, 'GET', '/v1/chats')).status, 403);
  assert.equal((await call(pub, 'POST', '/v1/ask', { question: 'Why is the sky blue?', chat_id: 'x' })).body.error.code, 'owner_only');
});

test('folders + chats: create, ask with history, title, pin, rename, move, delete', async () => {
  const { DB, prompts, call } = setup();
  const owner = await key(DB, 'owner');
  const math = (await call(owner, 'POST', '/v1/folders', { name: 'Math' })).body;
  assert.equal(math.name, 'Math');
  const chat = (await call(owner, 'POST', '/v1/chats', { folder_id: math.id })).body;
  assert.equal(chat.title, 'New chat');

  const a1 = await call(owner, 'POST', '/v1/ask', { question: 'Why does the quadratic formula have a plus or minus sign in it?', chat_id: chat.id });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.chat_id, chat.id);
  const a2 = await call(owner, 'POST', '/v1/ask', { question: 'Can you explain that more simply?', chat_id: chat.id });
  // second question sees the first exchange as history
  const msgs = prompts.at(-1);
  assert.deepEqual(msgs.slice(1, 3).map((m) => m.role), ['user', 'assistant']);
  assert.match(msgs[1].content, /quadratic formula/);
  assert.equal(msgs.at(-1).content, 'Can you explain that more simply?');

  const got = (await call(owner, 'GET', `/v1/chats/${chat.id}`)).body;
  assert.equal(got.messages.length, 4);
  assert.equal(got.chat.title, 'Why does the quadratic formula have a plus…');
  assert.equal(got.messages[1].meta.mode, 'general');

  assert.equal((await call(owner, 'PATCH', `/v1/chats/${chat.id}`, { pinned: true, title: 'Quadratics' })).body.pinned, true);
  const list = (await call(owner, 'GET', '/v1/chats')).body;
  assert.deepEqual([list.chats[0].title, list.chats[0].pinned, list.chats[0].folder_id], ['Quadratics', true, math.id]);
  assert.equal((await call(owner, 'PATCH', `/v1/chats/${chat.id}`, { folder_id: 'nope' })).body.error.code, 'folder_not_found');

  // deleting the folder keeps the chat, unfiled
  await call(owner, 'DELETE', `/v1/folders/${math.id}`);
  assert.equal((await call(owner, 'GET', `/v1/chats/${chat.id}`)).body.chat.folder_id, null);
  // deleting the chat removes its messages
  await call(owner, 'DELETE', `/v1/chats/${chat.id}`);
  assert.equal((await call(owner, 'GET', `/v1/chats/${chat.id}`)).status, 404);
  assert.equal(DB.raw.prepare('SELECT count(*) n FROM chat_messages').get().n, 0);
});

test('a new chat in the "Math" folder remembers other Math chats', async () => {
  const { DB, prompts, call } = setup();
  const owner = await key(DB, 'owner');
  const math = (await call(owner, 'POST', '/v1/folders', { name: 'Math' })).body;
  const other = (await call(owner, 'POST', '/v1/folders', { name: 'History' })).body;
  const c1 = (await call(owner, 'POST', '/v1/chats', { folder_id: math.id })).body;
  await call(owner, 'POST', '/v1/ask', { question: 'Help me factor x squared plus five x plus six for homework', chat_id: c1.id });
  const h = (await call(owner, 'POST', '/v1/chats', { folder_id: other.id })).body;
  await call(owner, 'POST', '/v1/ask', { question: 'Summarize the causes of World War One for me', chat_id: h.id });

  const c2 = (await call(owner, 'POST', '/v1/chats', { folder_id: math.id })).body;
  const r = await call(owner, 'POST', '/v1/ask', { question: 'Quiz me on what we did last time in math', chat_id: c2.id });
  const sys = prompts.at(-1)[0].content;
  assert.match(sys, /chat in the same folder, [\d-]+, "Math › Help me factor/);
  const folderSources = r.body.memory_sources.filter((m) => m.source === 'folder');
  assert.ok(folderSources.length > 0);
  assert.ok(folderSources.every((m) => m.title.startsWith('Math ›')), 'folder memory only from the same folder');

  // memory off: no folder context
  await call(owner, 'POST', '/v1/ask', { question: 'Quiz me on what we did last time in math', chat_id: c2.id, use_memory: false });
  assert.ok(!/same folder/.test(prompts.at(-1)[0].content));
});

test('memory commands inside a chat are saved to the chat too', async () => {
  const { DB, call } = setup();
  const owner = await key(DB, 'owner');
  const c = (await call(owner, 'POST', '/v1/chats', {})).body;
  const r = await call(owner, 'POST', '/v1/ask', { question: 'remember that my math teacher is Mr. Lee', chat_id: c.id });
  assert.equal(r.body.mode, 'memory');
  const got = (await call(owner, 'GET', `/v1/chats/${c.id}`)).body;
  assert.deepEqual(got.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(got.chat.title, 'remember that my math teacher is Mr. Lee');
});

test('titleFrom keeps titles short', () => {
  assert.equal(titleFrom('What is the derivative of x squared times sine of x please?'), 'What is the derivative of x squared times…');
  assert.equal(titleFrom('PID tuning?'), 'PID tuning');
});

test('CORS preflight allows every method the chat page uses (incl. PATCH)', async () => {
  const env = { DB: d1(), ALLOWED_ORIGINS: 'https://commandcenter12.github.io' };
  const res = await worker.fetch(new Request('http://api.test/v1/chats/x', { method: 'OPTIONS', headers: { Origin: 'https://commandcenter12.github.io', 'Access-Control-Request-Method': 'PATCH' } }), env, { waitUntil() {} });
  const allowed = res.headers.get('Access-Control-Allow-Methods').split(/,\s*/);
  for (const m of ['GET', 'POST', 'PATCH', 'DELETE']) assert.ok(allowed.includes(m), `${m} allowed`);
});
