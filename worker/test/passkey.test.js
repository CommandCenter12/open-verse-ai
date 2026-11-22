// Passkey flow against an in-memory D1 stand-in (node:sqlite) and a software authenticator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SoftAuthenticator } from './helpers/soft-authenticator.mjs';
import worker from '../src/index.js';

// Minimal D1 API over node:sqlite (prepare/bind/first/all/run/batch).
function d1() {
  const db = new DatabaseSync(':memory:');
  for (const f of ['0001_init.sql', '0002_memory.sql', '0003_passkeys.sql']) {
    db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  }
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

const ORIGIN = 'http://localhost:8080';
function setup() {
  const DB = d1();
  const env = { DB, IP_SALT: 'test', PASSKEY_ORIGINS: ORIGIN, ALLOWED_ORIGINS: ORIGIN, GENERAL_ENABLED: 'false' };
  const call = async (method, path, { auth, body, origin = ORIGIN } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (origin) headers.Origin = origin;
    const res = await worker.fetch(new Request(`http://api.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil() {} });
    return { status: res.status, body: await res.json() };
  };
  return { DB, env, call };
}

async function ownerKey(DB) {
  const { generateKey, sha256Hex } = await import('../src/keys.js');
  const key = generateKey();
  DB.raw.prepare("INSERT INTO api_keys (key_hash, prefix, label, created_at, scope) VALUES (?, ?, 'me', ?, 'owner')")
    .run(await sha256Hex(key), key.slice(0, 12), new Date().toISOString());
  return key;
}

async function register(call, owner, auth = new SoftAuthenticator()) {
  const opts = await call('POST', '/v1/passkeys/register/options', { auth: owner });
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const reg = await call('POST', '/v1/passkeys/register/verify', { auth: owner, body: { response: await auth.create(opts.body, ORIGIN), label: 'MacBook Touch ID' } });
  return { auth, reg };
}

async function login(call, auth, getOpts = {}) {
  const opts = await call('POST', '/v1/passkeys/login/options');
  return call('POST', '/v1/passkeys/login/verify', { body: { response: await auth.get(opts.body, getOpts.origin || ORIGIN, getOpts) }, origin: getOpts.sendOrigin || ORIGIN });
}

test('register with owner key, sign in with Touch ID, session acts as owner', async () => {
  const { DB, call } = setup();
  const owner = await ownerKey(DB);
  const { auth, reg } = await register(call, owner);
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const opts = await call('POST', '/v1/passkeys/register/options', { auth: owner });
  assert.equal(opts.body.rp.id, 'localhost');
  assert.equal(opts.body.authenticatorSelection.userVerification, 'required');
  assert.equal(opts.body.excludeCredentials[0].id, reg.body.id); // can't register the same device twice

  const s = await login(call, auth);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.match(s.body.token, /^ovs_[A-Za-z0-9_-]{43}$/);
  const me = await call('GET', '/v1/me', { auth: s.body.token });
  assert.deepEqual([me.body.scope, me.body.via, me.body.prefix], ['owner', 'session', owner.slice(0, 12)]);
  assert.equal((await call('POST', '/v1/memory/search', { auth: s.body.token, body: { question: 'my projects' } })).status, 200);
  const list = await call('GET', '/v1/passkeys', { auth: s.body.token });
  assert.equal(list.body.passkeys[0].label, 'MacBook Touch ID');
  // only the hash of the session token is stored
  assert.equal(DB.raw.prepare('SELECT count(*) n FROM sessions WHERE token_hash = ?').get(s.body.token).n, 0);
});

test('a session cannot escalate: no passkey changes, no key revocation', async () => {
  const { DB, call } = setup();
  const owner = await ownerKey(DB);
  const { auth, reg } = await register(call, owner);
  const token = (await login(call, auth)).body.token;
  assert.equal((await call('POST', '/v1/passkeys/register/options', { auth: token })).body.error.code, 'owner_key_required');
  assert.equal((await call('DELETE', `/v1/passkeys/${reg.body.id}`, { auth: token })).body.error.code, 'owner_key_required');
  assert.equal((await call('DELETE', '/v1/keys/current', { auth: token })).body.error.code, 'owner_key_required');
  assert.equal((await call('GET', '/v1/me', { auth: owner })).status, 200); // owner key still alive
});

test('sign-out, passkey deletion and owner-key revocation all end sessions', async () => {
  const { DB, call } = setup();
  const owner = await ownerKey(DB);
  const { auth, reg } = await register(call, owner);
  let t = (await login(call, auth)).body.token;
  assert.equal((await call('DELETE', '/v1/sessions/current', { auth: t })).status, 200);
  assert.equal((await call('GET', '/v1/me', { auth: t })).body.error.code, 'session_expired');

  t = (await login(call, auth)).body.token;
  assert.equal((await call('DELETE', `/v1/passkeys/${reg.body.id}`, { auth: owner })).status, 200);
  assert.equal((await call('GET', '/v1/me', { auth: t })).status, 401);
  assert.equal((await login(call, auth)).body.error.code, 'unknown_passkey');

  const { auth: a2 } = await register(call, owner);
  t = (await login(call, a2)).body.token;
  assert.equal((await call('DELETE', '/v1/keys/current', { auth: owner })).status, 200);
  assert.equal((await call('GET', '/v1/me', { auth: t })).status, 401);
  assert.equal((await login(call, a2)).body.error.code, 'unknown_passkey');
});

test('expired sessions are rejected', async () => {
  const { DB, call } = setup();
  const owner = await ownerKey(DB);
  const { auth } = await register(call, owner);
  const t = (await login(call, auth)).body.token;
  DB.raw.prepare('UPDATE sessions SET expires_at = 1').run();
  assert.equal((await call('GET', '/v1/me', { auth: t })).body.error.code, 'session_expired');
});

test('attacks fail: no fingerprint, tampered signature, replayed counter, reused challenge, wrong origin', async () => {
  const { DB, call } = setup();
  const owner = await ownerKey(DB);
  const { auth } = await register(call, owner);

  assert.equal((await login(call, auth, { uv: false })).body.error.code, 'passkey_verification_failed');
  assert.equal((await login(call, auth, { tamper: true })).body.error.code, 'passkey_verification_failed');
  assert.equal((await login(call, auth, { counter: 50 })).status, 200);
  assert.equal((await login(call, auth, { counter: 50 })).body.error.code, 'passkey_verification_failed'); // cloned authenticator

  const opts = await call('POST', '/v1/passkeys/login/options');
  const resp = await auth.get(opts.body, ORIGIN);
  assert.equal((await call('POST', '/v1/passkeys/login/verify', { body: { response: resp } })).status, 200);
  assert.equal((await call('POST', '/v1/passkeys/login/verify', { body: { response: resp } })).body.error.code, 'invalid_challenge');

  assert.equal((await call('POST', '/v1/passkeys/login/options', { origin: 'https://evil.example' })).body.error.code, 'origin_not_allowed');
  assert.equal((await call('POST', '/v1/passkeys/login/options', { origin: null })).body.error.code, 'origin_not_allowed');
  // signed for a phishing origin, replayed to the real API from the real origin
  assert.equal((await login(call, auth, { origin: 'https://evil.example' })).body.error.code, 'passkey_verification_failed');
  // signed for another RP ID
  assert.equal((await login(call, auth, { rpId: 'evil.example' })).body.error.code, 'passkey_verification_failed');
});

test('public keys cannot register passkeys; registration without fingerprint is refused', async () => {
  const { DB, call } = setup();
  const pub = (await call('POST', '/v1/keys', { body: {} })).body.key;
  assert.equal((await call('POST', '/v1/passkeys/register/options', { auth: pub })).body.error.code, 'owner_only');
  const owner = await ownerKey(DB);
  const opts = await call('POST', '/v1/passkeys/register/options', { auth: owner });
  const r = await call('POST', '/v1/passkeys/register/verify', { auth: owner, body: { response: await new SoftAuthenticator().create(opts.body, ORIGIN, { uv: false }) } });
  assert.equal(r.body.error.code, 'passkey_verification_failed');
});

test('passkey endpoints are rate limited per network', async () => {
  const { env, call } = setup();
  env.PASSKEY_ATTEMPTS_PER_HOUR = '3';
  for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/v1/passkeys/login/options')).status, 200);
  const r = await call('POST', '/v1/passkeys/login/options');
  assert.equal(r.status, 429);
});
