// API key generation, hashing and lookup. Only SHA-256 hashes are stored.
import { HttpError } from './http.js';

export const KEY_PREFIX = 'ova_';
const KEY_RE = /^ova_[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url, no padding
const SESSION_RE = /^ovs_[A-Za-z0-9_-]{43}$/; // passkey sign-in session (see passkeys.js)

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return KEY_PREFIX + base64url(bytes);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function displayPrefix(key) {
  return key.slice(0, 12);
}

export function extractKey(request) {
  const auth = request.headers.get('Authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (!m) throw new HttpError(401, 'invalid_auth_header', 'Use "Authorization: Bearer <key>".');
    return m[1];
  }
  const xkey = request.headers.get('X-API-Key');
  if (xkey) return xkey.trim();
  return null;
}

export function isWellFormed(key) {
  return KEY_RE.test(key);
}

export async function createKey(db, label) {
  const key = generateKey();
  const hash = await sha256Hex(key);
  const now = new Date().toISOString();
  await db
    .prepare('INSERT INTO api_keys (key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?)')
    .bind(hash, displayPrefix(key), label, now)
    .run();
  return { key, prefix: displayPrefix(key), label, created_at: now };
}

// Returns the key row (without the hash) or throws 401.
export async function authenticate(request, db) {
  const key = extractKey(request);
  if (!key) {
    throw new HttpError(401, 'missing_api_key', 'Send your key as "Authorization: Bearer <key>" or "X-API-Key: <key>".', {
      'WWW-Authenticate': 'Bearer',
    });
  }
  if (SESSION_RE.test(key)) {
    const s = await db
      .prepare(
        'SELECT k.*, s.token_hash AS session_hash, s.expires_at AS session_expires_at FROM sessions s ' +
          'JOIN api_keys k ON k.id = s.key_id WHERE s.token_hash = ? AND s.expires_at > ? AND k.revoked_at IS NULL'
      )
      .bind(await sha256Hex(key), Math.floor(Date.now() / 1000))
      .first();
    if (!s) throw new HttpError(401, 'session_expired', 'Session expired or signed out. Sign in with your passkey again.', { 'WWW-Authenticate': 'Bearer' });
    return { ...s, scope: s.scope === 'owner' ? 'owner' : 'public', via: 'session' };
  }
  if (!isWellFormed(key)) {
    throw new HttpError(401, 'invalid_api_key', 'API key is malformed.', { 'WWW-Authenticate': 'Bearer' });
  }
  const hash = await sha256Hex(key);
  const row = await db
    // SELECT * so this keeps working before migration 0002 adds `scope`.
    .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(hash)
    .first();
  if (!row) {
    throw new HttpError(401, 'invalid_api_key', 'API key is unknown or revoked.', { 'WWW-Authenticate': 'Bearer' });
  }
  return { ...row, scope: row.scope === 'owner' ? 'owner' : 'public', via: 'key' };
}

export async function touchKey(db, id) {
  await db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
}

export async function revokeKey(db, id) {
  await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
}
