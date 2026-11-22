// Passkey (WebAuthn) sign-in for owner keys: Touch ID / Face ID / Windows Hello / security keys.
// Signature and attestation checks are done by @simplewebauthn/server; this file handles
// challenges, storage and sessions.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL, decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { HttpError } from './http.js';
import { sha256Hex } from './keys.js';
import { hit, intVar } from './ratelimit.js';

const CHALLENGE_TTL = 300; // seconds
const MAX_PASSKEYS_PER_KEY = 10;
export const SESSION_PREFIX = 'ovs_';

const now = () => Math.floor(Date.now() / 1000);

// The WebAuthn relying party is the page's origin (the portal), not the API's.
export function passkeyContext(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.PASSKEY_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) {
    throw new HttpError(403, 'origin_not_allowed', 'Passkeys only work from the Open Verse Ai portal.');
  }
  return { origin, rpID: new URL(origin).hostname };
}

export async function limitPasskeyAttempts(request, env) {
  if (!env.IP_SALT) throw new Error('IP_SALT secret is not configured');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256Hex(`${env.IP_SALT}:${ip}`);
  const hour = Math.floor(Date.now() / 3600000);
  const limit = intVar(env.PASSKEY_ATTEMPTS_PER_HOUR, 30);
  if ((await hit(env.DB, `pk:ip:${ipHash}:${hour}`, 7200)) > limit) {
    throw new HttpError(429, 'passkey_rate_limited', `At most ${limit} passkey attempts per hour.`, {
      'Retry-After': String(3600 - (now() % 3600)),
    });
  }
}

async function saveChallenge(db, challenge, kind, ctx, keyId = null) {
  await db
    .prepare('INSERT INTO webauthn_challenges (challenge, kind, key_id, rp_id, origin, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(challenge, kind, keyId, ctx.rpID, ctx.origin, now() + CHALLENGE_TTL)
    .run();
}

// Atomically deletes and returns a matching, unexpired challenge (single use).
async function consumeChallenge(db, response, kind, ctx, keyId = null) {
  let challenge;
  try {
    challenge = decodeClientDataJSON(response.response.clientDataJSON).challenge;
  } catch {
    throw new HttpError(400, 'invalid_passkey_response', 'Malformed passkey response.');
  }
  const row = await db
    .prepare(
      'DELETE FROM webauthn_challenges WHERE challenge = ? AND kind = ? AND rp_id = ? AND origin = ? AND expires_at > ? ' +
        'AND (key_id IS ? OR key_id = ?) RETURNING challenge'
    )
    .bind(challenge, kind, ctx.rpID, ctx.origin, now(), keyId, keyId)
    .first();
  if (!row) throw new HttpError(400, 'invalid_challenge', 'Passkey challenge is unknown, expired or already used. Start again.');
  return challenge;
}

function requireCredential(body) {
  const r = body && body.response;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.response || typeof r.response.clientDataJSON !== 'string') {
    throw new HttpError(400, 'invalid_passkey_response', 'Send {"response": <PublicKeyCredential JSON>}.');
  }
  return r;
}

const verifyFailed = (err) =>
  new HttpError(400, 'passkey_verification_failed', `Passkey could not be verified: ${err && err.message ? err.message : 'unknown error'}`);

// ---------- registration (requires an owner API key, never a session) ----------
export async function registrationOptions(db, keyRow, ctx) {
  const { results } = await db.prepare('SELECT id, transports FROM passkeys WHERE key_id = ? AND rp_id = ?').bind(keyRow.id, ctx.rpID).all();
  if ((results || []).length >= MAX_PASSKEYS_PER_KEY) {
    throw new HttpError(409, 'too_many_passkeys', `At most ${MAX_PASSKEYS_PER_KEY} passkeys per owner key. Delete one first.`);
  }
  const options = await generateRegistrationOptions({
    rpName: 'Open Verse Ai',
    rpID: ctx.rpID,
    userName: `owner-${keyRow.prefix}`,
    userDisplayName: `Open Verse Ai owner (${keyRow.label || keyRow.prefix})`,
    userID: new TextEncoder().encode(`ova-owner-${keyRow.id}`),
    attestationType: 'none',
    excludeCredentials: (results || []).map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257], // ES256 (Touch ID, most keys), RS256 (Windows Hello)
  });
  await saveChallenge(db, options.challenge, 'register', ctx, keyRow.id);
  return options;
}

export async function registerPasskey(db, keyRow, ctx, body) {
  const response = requireCredential(body);
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) || null : null;
  const challenge = await consumeChallenge(db, response, 'register', ctx, keyRow.id);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ctx.origin,
      expectedRPID: ctx.rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    throw verifyFailed(err);
  }
  if (!v.verified) throw verifyFailed();
  const { credential, credentialBackedUp } = v.registrationInfo;
  try {
    await db
      .prepare(
        'INSERT INTO passkeys (id, key_id, public_key, counter, transports, rp_id, label, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        credential.id,
        keyRow.id,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        ctx.rpID,
        label,
        credentialBackedUp ? 1 : 0,
        new Date().toISOString()
      )
      .run();
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err && err.message))) throw new HttpError(409, 'passkey_exists', 'This passkey is already registered.');
    throw err;
  }
  return { registered: true, id: credential.id, label, synced: Boolean(credentialBackedUp) };
}

// ---------- sign-in (no API key; the passkey is the credential) ----------
export async function authenticationOptions(db, ctx) {
  const options = await generateAuthenticationOptions({ rpID: ctx.rpID, userVerification: 'required', allowCredentials: [] });
  await saveChallenge(db, options.challenge, 'login', ctx);
  return options;
}

export async function signIn(db, ctx, body, env) {
  const response = requireCredential(body);
  const challenge = await consumeChallenge(db, response, 'login', ctx);
  const pk = await db
    .prepare(
      'SELECT p.*, k.prefix FROM passkeys p JOIN api_keys k ON k.id = p.key_id ' +
        "WHERE p.id = ? AND p.rp_id = ? AND k.revoked_at IS NULL AND k.scope = 'owner'"
    )
    .bind(response.id, ctx.rpID)
    .first();
  if (!pk) throw new HttpError(401, 'unknown_passkey', 'This passkey is not registered, or its owner key was revoked.');
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: ctx.origin,
      expectedRPID: ctx.rpID,
      credential: {
        id: pk.id,
        publicKey: isoBase64URL.toBuffer(pk.public_key),
        counter: pk.counter,
        transports: pk.transports ? JSON.parse(pk.transports) : undefined,
      },
      requireUserVerification: true,
    });
  } catch (err) {
    throw verifyFailed(err);
  }
  if (!v.verified) throw verifyFailed();

  const token = SESSION_PREFIX + isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
  const ttl = intVar(env.SESSION_HOURS, 12) * 3600;
  const expires = now() + ttl;
  await db.batch([
    db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').bind(v.authenticationInfo.newCounter, new Date().toISOString(), pk.id),
    db.prepare('INSERT INTO sessions (token_hash, key_id, passkey_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256Hex(token), pk.key_id, pk.id, new Date().toISOString(), expires),
  ]);
  return { token, expires_at: new Date(expires * 1000).toISOString(), passkey: pk.label || pk.id.slice(0, 8), key_prefix: pk.prefix };
}

export async function listPasskeys(db, keyId) {
  const { results } = await db
    .prepare('SELECT id, label, rp_id, backed_up, created_at, last_used_at FROM passkeys WHERE key_id = ? ORDER BY created_at')
    .bind(keyId)
    .all();
  return (results || []).map((p) => ({ ...p, synced: Boolean(p.backed_up), backed_up: undefined }));
}

export async function deletePasskey(db, keyId, id) {
  const r = await db.prepare('DELETE FROM passkeys WHERE id = ? AND key_id = ? RETURNING id').bind(id, keyId).first();
  if (!r) throw new HttpError(404, 'not_found', 'No such passkey for this owner key.');
  await db.prepare('DELETE FROM sessions WHERE passkey_id = ?').bind(id).run(); // sign out its sessions
  return { deleted: true, id };
}

export async function cleanupPasskeys(db) {
  await db.batch([
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < ?').bind(now()),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
  ]);
}
