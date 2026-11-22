// Open Verse Ai API: Cloudflare Worker entry point.
import { HttpError, json, errorResponse, readJson, corsHeaders, withHeaders } from './http.js';
import { createKey, authenticate, touchKey, revokeKey, sha256Hex } from './keys.js';
import { enforceAsk, usage, hit, intVar, windows, cleanup, reserveGeneral } from './ratelimit.js';
import { validateQuestion } from './qa.js';
import { resolveAsk } from './ask.js';
import { aiConfigured, DEFAULT_MODEL } from './general.js';
import { loadMemory } from './memory.js';
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
    await revokeKey(env.DB, row.id);
    return json({ revoked: true, prefix: row.prefix });
  }

  if (path === '/v1/me') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Use GET.');
    const row = await authenticate(request, env.DB);
    return json({
      prefix: row.prefix,
      scope: row.scope,
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
    const { question, topK, sourcesOnly, useMemory } = validateQuestion(body);
    const rl = await enforceAsk(env.DB, row.key_hash, env);
    ctx.waitUntil(touchKey(env.DB, row.id));
    const result = await resolveAsk({
      index: INDEX,
      question,
      topK,
      sourcesOnly,
      env,
      reserveGeneral: () => reserveGeneral(env.DB, row.key_hash, env),
      // Personal memory is only ever read for owner keys.
      loadMemory: row.scope === 'owner' && useMemory ? () => loadMemory(env.DB, question) : null,
    });
    return json(result, 200, rl);
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
    return json({ question, profile_present: Boolean(memory.profile), chunks: memory.chunks }, 200, rl);
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
    ctx.waitUntil(cleanup(env.DB));
  },
};
