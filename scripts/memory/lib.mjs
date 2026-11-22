// Shared helpers for the local memory pipeline. Nothing here talks to the network
// except runWrangler(), which only runs when upload/owner-key are invoked.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PRIVATE = join(ROOT, 'private');
export const WORKER = join(ROOT, 'worker');

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

export async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export function words(text) {
  return (String(text).toLowerCase().match(/[a-z0-9][a-z0-9'+#.-]*[a-z0-9]|[a-z0-9]/g) || []);
}

export function isoDate(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function stripHtml(html) {
  return String(html)
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Runs wrangler in worker/. `target` is '--local' or '--remote'.
export function runWrangler(wranglerArgs, { quiet = false } = {}) {
  const r = spawnSync('npx', ['wrangler', ...wranglerArgs], { cwd: WORKER, encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stdout || '') + (r.stderr || '');
    throw new Error(`wrangler ${wranglerArgs.slice(0, 3).join(' ')} failed:\n${msg.slice(-1500)}`);
  }
  if (!quiet) process.stdout.write(r.stdout);
  return r.stdout;
}

export function target(opts) {
  if (opts.local && opts.remote) throw new Error('Pass only one of --local or --remote.');
  if (opts.local) return '--local';
  if (opts.remote) return '--remote';
  throw new Error('Pass --local (dev database) or --remote (live database).');
}
