// JSON responses, errors and CORS.

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message } }, err.status, err.headers);
  }
  console.error('unhandled', err && err.stack ? err.stack : err);
  return json({ error: { code: 'internal_error', message: 'Something went wrong. Try again later.' } }, 500);
}

const MAX_BODY_BYTES = 4096;

export async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the body as application/json.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new HttpError(413, 'payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes.`);
  }
  if (!text.trim()) return {};
  try {
    const body = JSON.parse(text);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Body is not a valid JSON object.');
  }
}

// CORS is a browser convenience, not access control: auth is the API key.
export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, X-API-Key, Content-Type',
    'Access-Control-Expose-Headers': 'X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function withHeaders(response, headers) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(headers)) r.headers.set(k, v);
  return r;
}
