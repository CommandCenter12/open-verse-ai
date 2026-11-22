// Fixed-window counters stored in D1. One atomic UPSERT per check.
import { HttpError } from './http.js';

export function intVar(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function hit(db, bucket, ttlSeconds) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const row = await db
    .prepare(
      'INSERT INTO counters (bucket, count, expires_at) VALUES (?, 1, ?) ' +
        'ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count'
    )
    .bind(bucket, expires)
    .first();
  return row.count;
}

export async function peek(db, bucket) {
  const row = await db.prepare('SELECT count FROM counters WHERE bucket = ?').bind(bucket).first();
  return row ? row.count : 0;
}

export function windows(now = new Date()) {
  const minute = Math.floor(now.getTime() / 60000);
  const day = now.toISOString().slice(0, 10);
  const secsToNextMinute = 60 - now.getUTCSeconds();
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const secsToNextDay = Math.ceil((nextDay - now.getTime()) / 1000);
  return { minute, day, secsToNextMinute, secsToNextDay };
}

// Enforces per-minute rate then per-day quota for one API key hash.
export async function enforceAsk(db, keyHash, env) {
  const perMin = intVar(env.RATE_PER_MINUTE, 20);
  const perDay = intVar(env.QUOTA_PER_DAY, 500);
  const w = windows();

  const m = await hit(db, `ask:m:${keyHash}:${w.minute}`, 120);
  if (m > perMin) {
    throw new HttpError(429, 'rate_limited', `Limit is ${perMin} requests per minute.`, {
      'Retry-After': String(w.secsToNextMinute),
      'X-RateLimit-Limit': String(perMin),
      'X-RateLimit-Remaining': '0',
    });
  }
  const d = await hit(db, `ask:d:${keyHash}:${w.day}`, 2 * 86400);
  if (d > perDay) {
    throw new HttpError(429, 'quota_exceeded', `Daily quota of ${perDay} requests used. Resets at 00:00 UTC.`, {
      'Retry-After': String(w.secsToNextDay),
      'X-RateLimit-Limit': String(perDay),
      'X-RateLimit-Remaining': '0',
    });
  }
  return { 'X-RateLimit-Limit': String(perMin), 'X-RateLimit-Remaining': String(Math.max(0, perMin - m)) };
}

export async function usage(db, keyHash, env) {
  const w = windows();
  const perMin = intVar(env.RATE_PER_MINUTE, 20);
  const perDay = intVar(env.QUOTA_PER_DAY, 500);
  // Counters also count rejected attempts, so clamp for display.
  return {
    minute: { used: Math.min(perMin, await peek(db, `ask:m:${keyHash}:${w.minute}`)), limit: perMin },
    day: { used: Math.min(perDay, await peek(db, `ask:d:${keyHash}:${w.day}`)), limit: perDay },
  };
}

export async function cleanup(db) {
  await db.prepare('DELETE FROM counters WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)).run();
}
