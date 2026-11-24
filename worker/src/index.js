// Open Verse Ai API: Cloudflare Worker entry point.
import { HttpError, json, errorResponse, readJson, corsHeaders, withHeaders } from './http.js';
import { createKey, authenticate, touchKey, revokeKey, sha256Hex } from './keys.js';
import { enforceAsk, usage, hit, intVar, windows, cleanup, reserveGeneral } from './ratelimit.js';
import { validateQuestion } from './qa.js';
import { resolveAsk } from './ask.js';
import { aiConfigured, DEFAULT_MODEL, MODELS, MODEL_ORDER, modelChain, PLUS } from './general.js';
import { loadMemory } from './memory.js';
import { handleChats, chatHistory, saveExchange, folderMemory } from './chats.js';
import { parseCommand, handleCommand, shouldLearn, saveConversation, pruneLearned, LEARNED_SOURCE } from './learn.js';
import {
  passkeyContext, limitPasskeyAttempts, registrationOptions, registerPasskey,
  authenticationOptions, signIn, listPasskeys, deletePasskey, cleanupPasskeys,
} from './passkeys.js';

// Owner API key presented directly (not a session). Used for actions a stolen
// session must not be able to do: adding/removing passkeys, revoking the key.
function requireOwnerKey(row) {
  if (row.scope !== 'owner') throw new HttpError(403, 'owner_only', 'This endpoint requires an owner key.');
  if (row.via !== 'key') throw new HttpError(403, 'owner_key_required', 'Use your owner API key for this, not a passkey session.');
}
import INDEX from './knowledge-index.json';

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (path === '/' || path === '/v1/health') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    return json({
      ok: true,
      service: 'open-verse-ai',
      index: { chunks: INDEX.N, built_at: INDEX.builtAt },
      general: { enabled: aiConfigured(env), model: env.AI_MODEL || DEFAULT_MODEL },
    });
  }

  if (path === '/v1/models') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    return json({
      default: 'auto',
      auto_order: modelChain(env, 'auto'),
      models: MODEL_ORDER.map((k) => ({ key: k, ...MODELS[k] })),
      combined: { key: PLUS.key, name: PLUS.name, members: PLUS.members, note: PLUS.note },
    });
  }

  if (path === '/v1/keys') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
    if (!env.IP_SALT) throw new Error('IP_SALT secret is not configured');
    const body = await readJson(request);
    let label = null;
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || body.label.trim().length > 60) {
        throw new HttpError(400, 'invalid_label', '"label" must be a string of at most 60 characters.');
      }
      label = body.label.trim() || null;
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipHash = await sha256Hex(`${env.IP_SALT}:${ip}`);
    const limit = intVar(env.KEYS_PER_IP_DAY, 3);
    const w = windows();
    const n = await hit(env.DB, `keys:ip:${ipHash}:${w.day}`, 2 * 86400);
    if (n > limit) {
      throw new HttpError(429, 'key_limit', `At most ${limit} new keys per day from one network.`, {
        'Retry-After': String(w.secsToNextDay),
      });
    }
    const created = await createKey(env.DB, label);
    return json({ ...created, note: 'Store this key now. It is shown only once and cannot be recovered.' }, 201);
  }

  if (path === '/v1/keys/current') {
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', 'Use DELETE.');
    const row = await authenticate(request, env.DB);
    if (row.via === 'session') {
      throw new HttpError(403, 'owner_key_required', 'A passkey session cannot revoke the owner key. Use DELETE /v1/sessions/current to sign out.');
    }
    await revokeKey(env.DB, row.id);
    return json({ revoked: true, prefix: row.prefix });
  }

  if (path === '/v1/me') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    const row = await authenticate(request, env.DB);
    return json({
      prefix: row.prefix,
      scope: row.scope,
      via: row.via,
      ...(row.via === 'session' ? { session_expires_at: new Date(row.session_expires_at * 1000).toISOString() } : {}),
      label: row.label,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      usage: await usage(env.DB, row.key_hash, env),
    });
  }

  if (path === '/v1/ask') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
    const row = await authenticate(request, env.DB);
    const body = await readJson(request); // validate before spending quota
    const { question, topK, sourcesOnly, useMemory, model, style, attachments } = validateQuestion(body);
    // Optional saved chat (owner only): its recent messages give the model context, and the
    // exchange is saved back to it.
    let chat = null;
    let history = [];
    if (body.chat_id !== undefined) {
      if (row.scope !== 'owner') throw new HttpError(403, 'owner_only', 'Saved chats need an owner key.');
      if (typeof body.chat_id !== 'string') throw new HttpError(400, 'invalid_chat_id', '"chat_id" must be a string.');
      ({ chat, history } = await chatHistory(env.DB, body.chat_id));
    }
    const rl = await enforceAsk(env.DB, row.key_hash, env);
    ctx.waitUntil(touchKey(env.DB, row.id));
    const learning = row.scope === 'owner' && useMemory && env.MEMORY_LEARN !== 'false';
    const finish = async (result) => {
      if (chat) { await saveExchange(env.DB, chat, question, result, history.length === 0, attachments.map((a) => a.name)); result.chat_id = chat.id; }
      return json(result, 200, rl);
    };
    if (learning) {
      const cmd = parseCommand(question);
      if (cmd) return finish(await handleCommand(env.DB, cmd, question));
    }
    const result = await resolveAsk({
      index: INDEX,
      question,
      topK,
      sourcesOnly,
      env,
      reserveGeneral: () => reserveGeneral(env.DB, row.key_hash, env),
      model,
      style,
      attachments,
      // Personal memory is only ever read for owner keys.
      loadMemory: row.scope === 'owner' && useMemory
        ? async () => {
            const m = await loadMemory(env.DB, question);
            const folder = await folderMemory(env.DB, chat).catch(() => []);
            return { ...m, chunks: [...folder, ...m.chunks].slice(0, 5) };
          }
        : null,
      history,
      // Approximate location of the caller (from Cloudflare), only for "weather" with no city.
      where: request.cf && request.cf.latitude ? { latitude: request.cf.latitude, longitude: request.cf.longitude, city: request.cf.city, country: request.cf.country } : null,
    });
    if (learning && shouldLearn(result)) {
      ctx.waitUntil(saveConversation(env.DB, question, result).catch((e) => console.error('learn failed', e.message)));
      result.learned = true;
    }
    return finish(result);
  }

  // Owner-only: saved chats and folders for the chat page.
  if (path === '/v1/chats' || path.startsWith('/v1/chats/') || path === '/v1/folders' || path.startsWith('/v1/folders/')) {
    const row = await authenticate(request, env.DB);
    if (row.scope !== 'owner') throw new HttpError(403, 'owner_only', 'Saved chats need an owner key.');
    const [status, body] = await handleChats(request, env, path, method, readJson);
    return json(body, status);
  }

  // Owner-only: saved facts.
  if (path === '/v1/memory/facts' || path.startsWith('/v1/memory/facts/')) {
    const row = await authenticate(request, env.DB);
    if (row.scope !== 'owner') throw new HttpError(403, 'owner_only', 'This endpoint requires an owner key.');
    if (path === '/v1/memory/facts') {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
      const { results } = await env.DB.prepare('SELECT id, kind, text, context, created_at FROM memory_facts ORDER BY id DESC').all();
      const learned = await env.DB.prepare('SELECT count(*) AS n FROM memory_fts WHERE source = ?').bind(LEARNED_SOURCE).first();
      return json({ facts: results || [], learned_conversations: learned ? learned.n : 0 });
    }
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', 'Use DELETE.');
    const id = Number(path.slice('/v1/memory/facts/'.length));
    const r = await env.DB.prepare('DELETE FROM memory_facts WHERE id = ? RETURNING id').bind(id).first();
    if (!r) throw new HttpError(404, 'not_found', 'No such fact.');
    return json({ deleted: true, id });
  }

  // Owner-only: see exactly which memory would be retrieved, without calling the model.
  if (path === '/v1/memory/search') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
    const row = await authenticate(request, env.DB);
    if (row.scope !== 'owner') throw new HttpError(403, 'owner_only', 'This endpoint requires an owner key.');
    const body = await readJson(request);
    const { question } = validateQuestion(body);
    const rl = await enforceAsk(env.DB, row.key_hash, env);
    const memory = await loadMemory(env.DB, question);
    return json({ question, profile_present: Boolean(memory.profile), facts: memory.facts, chunks: memory.chunks }, 200, rl);
  }

  // ---------- Passkeys (Touch ID) ----------
  if (path === '/v1/passkeys/register/options' || path === '/v1/passkeys/register/verify') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
    const ctx = passkeyContext(request, env);
    const row = await authenticate(request, env.DB);
    requireOwnerKey(row);
    await limitPasskeyAttempts(request, env);
    if (path.endsWith('/options')) return json(await registrationOptions(env.DB, row, ctx));
    return json(await registerPasskey(env.DB, row, ctx, await readJson(request)), 201);
  }
  if (path === '/v1/passkeys/login/options' || path === '/v1/passkeys/login/verify') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST.');
    const ctx = passkeyContext(request, env);
    await limitPasskeyAttempts(request, env);
    if (path.endsWith('/options')) return json(await authenticationOptions(env.DB, ctx));
    return json(await signIn(env.DB, ctx, await readJson(request), env));
  }
  if (path === '/v1/passkeys') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    const row = await authenticate(request, env.DB);
    if (row.scope !== 'owner') throw new HttpError(403, 'owner_only', 'This endpoint requires an owner key.');
    return json({ passkeys: await listPasskeys(env.DB, row.id) });
  }
  if (path.startsWith('/v1/passkeys/')) {
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', 'Use DELETE.');
    const row = await authenticate(request, env.DB);
    requireOwnerKey(row);
    return json(await deletePasskey(env.DB, row.id, decodeURIComponent(path.slice('/v1/passkeys/'.length))));
  }
  if (path === '/v1/sessions/current') {
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', 'Use DELETE.');
    const row = await authenticate(request, env.DB);
    if (row.via !== 'session') throw new HttpError(400, 'not_a_session', 'Send the session token (ovs_…) to sign out.');
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(row.session_hash).run();
    return json({ signed_out: true });
  }

  throw new HttpError(404, 'not_found', `No route for ${method} ${path}.`);
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (err) {
      response = errorResponse(err);
    }
    return withHeaders(response, cors);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([cleanup(env.DB), cleanupPasskeys(env.DB).catch(() => {}), pruneLearned(env.DB).catch(() => {})]));
  },
};
