#!/usr/bin/env node
// Creates an OWNER key (the only kind that can read personal memory) and prints it once.
// Only the SHA-256 hash goes into D1. POST /v1/keys can never create owner keys.
//   node scripts/memory/owner-key.mjs --local
//   node scripts/memory/owner-key.mjs --remote [--label "command center"]
import { args, target, runWrangler } from './lib.mjs';
import { generateKey, sha256Hex, displayPrefix } from '../../worker/src/keys.js';

const opts = args();
const where = target(opts);
const label = String(opts.label || 'owner').slice(0, 60).replace(/'/g, "''");
const key = generateKey();
const hash = await sha256Hex(key);
runWrangler(['d1', 'execute', 'open-verse-ai', where, '--yes', '--command',
  `INSERT INTO api_keys (key_hash, prefix, label, created_at, scope) VALUES ('${hash}', '${displayPrefix(key)}', '${label}', '${new Date().toISOString()}', 'owner')`], { quiet: true });
console.log(`Owner key (${where.slice(2)} database). Shown once; store it in your password manager:\n\n${key}\n`);
console.log('Revoke it any time with: curl -X DELETE <api>/v1/keys/current -H "Authorization: Bearer <key>"');
