// Google Takeout → normalized documents for memory.
// Document shape: { source, doc_id, title, ts, text }
//   drive     Takeout/Drive/**        .txt .md .html .htm .docx  (pick TXT/HTML/DOCX for Google Docs)
//   gmail     Takeout/Mail/*.mbox     SENT mail only (X-Gmail-Labels: Sent, or From: --me)
//   keep      Takeout/Keep/*.json     non-trashed notes
//   calendar  Takeout/Calendar/*.ics  event titles grouped per month (no locations/attendees)
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { stripHtml, isoDate } from './lib.mjs';
import { readZipEntry } from './zip.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EMAIL_CHARS = 20000;
const id = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------- Drive ----------
export const DRIVE_EXTS = new Set(['.txt', '.md', '.html', '.htm', '.docx']);

export function docxText(buf) {
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw new Error('no word/document.xml');
  return xml.toString('utf8')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

export async function parseDriveFile(path) {
  const ext = extname(path).toLowerCase();
  if (!DRIVE_EXTS.has(ext)) return { skipped: ext || '(none)' };
  const st = await stat(path);
  if (st.size > MAX_FILE_BYTES) return { skipped: `${ext} >5MB` };
  const buf = await readFile(path);
  let text;
  if (ext === '.docx') text = docxText(buf);
  else if (ext === '.html' || ext === '.htm') text = stripHtml(buf.toString('utf8').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''));
  else text = buf.toString('utf8');
  return {
    doc: { source: 'drive', doc_id: id(path), title: basename(path, ext), ts: st.mtime.toISOString(), text: text.trim() },
  };
}

// ---------- Gmail (mbox) ----------
function decodeWords(s) {
  // RFC 2047: =?charset?B|Q?text?=
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(cs).decode(bytes);
    } catch { return txt; }
  }).replace(/\?=\s+=\?/g, '?==?');
}

function parseHeaders(text) {
  const headers = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] ??= m[2];
  }
  return headers;
}

function param(value, name) {
  const m = String(value || '').match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i'));
  return m ? (m[2] ?? m[1]) : null;
}

function decodeBody(body, headers) {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  const charset = param(headers['content-type'], 'charset') || 'utf-8';
  let bytes;
  if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') {
    bytes = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  } else bytes = Buffer.from(body, 'utf8');
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}

// Returns { plain, html } from a (possibly multipart) MIME entity.
function extractText(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return {};
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    const out = {};
    for (const p of parts) {
      const r = extractText(p.replace(/^\r?\n/, ''));
      out.plain ??= r.plain;
      out.html ??= r.html;
    }
    return out;
  }
  if (/attachment/i.test(headers['content-disposition'] || '')) return {};
  if (type.startsWith('text/plain')) return { plain: decodeBody(body, headers) };
  if (type.startsWith('text/html')) return { html: decodeBody(body, headers) };
  return {};
}

// Keeps only what you wrote: drops quoted replies, forwarded blocks and signatures.
export function ownText(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200}wrote:\s*$/.test(line) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(line) ||
        /^-- ?$/.test(line) || /^Sent from my /.test(line) || /^_{10,}$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseMessage(raw, { me = null } = {}) {
  const split = raw.search(/\r?\n\r?\n/);
  const headers = parseHeaders(split < 0 ? raw : raw.slice(0, split));
  const labels = (headers['x-gmail-labels'] || '').split(',').map((s) => s.trim().toLowerCase());
  const from = (headers.from || '').toLowerCase();
  const sent = labels.includes('sent') || (me && from.includes(me.toLowerCase()));
  if (!sent) return null;
  if (labels.includes('chat') || labels.includes('spam') || labels.includes('trash')) return null;
  const { plain, html } = extractText(raw);
  const text = ownText(plain || (html ? stripHtml(html) : ''));
  if (!text) return null;
  const subject = decodeWords(headers.subject || '').trim() || '(no subject)';
  return {
    source: 'gmail',
    doc_id: id(headers['message-id'] || `${headers.date}|${subject}|${text.slice(0, 80)}`),
    title: subject.replace(/^((re|fwd?|aw|sv):\s*)+/i, ''),
    ts: isoDate(headers.date),
    text: text.slice(0, MAX_EMAIL_CHARS),
  };
}

// Streams the mbox so multi-GB exports don't need to fit in memory.
export async function parseMbox(path, opts = {}) {
  const docs = [];
  let seen = 0;
  let cur = null;
  const flush = () => {
    if (cur === null) return;
    seen++;
    const d = parseMessage(cur.join('\n'), opts);
    if (d) docs.push(d);
    cur = null;
  };
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (/^From \S+ /.test(line)) { flush(); cur = []; continue; }
    if (cur) cur.push(line.replace(/^>(>*From )/, '$1'));
  }
  flush();
  return { docs, seen };
}

// ---------- Keep ----------
export function parseKeepNote(json, file) {
  if (!json || json.isTrashed) return null;
  const list = Array.isArray(json.listContent)
    ? json.listContent.map((i) => `${i.isChecked ? '[x]' : '[ ]'} ${i.text}`).join('\n')
    : '';
  const text = [json.textContent || '', list].filter(Boolean).join('\n').trim();
  if (!text && !json.title) return null;
  const usec = Number(json.userEditedTimestampUsec || json.createdTimestampUsec || 0);
  return {
    source: 'keep',
    doc_id: id(file),
    title: (json.title || text.split('\n')[0] || 'Keep note').slice(0, 80),
    ts: usec ? new Date(usec / 1000).toISOString() : null,
    text: text || json.title,
  };
}

// ---------- Calendar ----------
function icsDate(v) {
  const m = String(v || '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export function parseIcs(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const months = new Map();
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const get = (k) => (block.match(new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, 'm')) || [])[1];
    const status = get('STATUS');
    if (status && /cancelled/i.test(status)) continue;
    const date = icsDate(get('DTSTART'));
    const summary = (get('SUMMARY') || '').replace(/\\([,;n\\])/g, (_, c) => (c === 'n' ? ' ' : c)).trim();
    if (!date || !summary) continue;
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(`${date} ${summary}${get('RRULE') ? ' (recurring)' : ''}`);
  }
  return [...months.entries()].map(([month, events]) => ({
    source: 'calendar',
    doc_id: id(`calendar|${month}`),
    title: `Calendar ${month}`,
    ts: `${month}-01T00:00:00.000Z`,
    text: [...new Set(events)].sort().join('\n'),
  }));
}
