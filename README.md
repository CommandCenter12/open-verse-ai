# Open Verse Ai

Open-source, **citation-first** Q&A API for mechatronics and stock-analysis methods.
Every answer says where it came from (`mode`):

| `mode` | Source | Trust |
|---|---|---|
| `math` | Built-in arithmetic parser (`1+1` → `2`) | exact |
| `docs` | Sentences from [`knowledge/`](knowledge/) with citations | cited |
| `general` | Llama 3.3 70B on Cloudflare Workers AI, only when no doc matches | unverified, no sources |
| `none` | Nothing applies → `"answered": false` + `general_unavailable` reason | n/a |

Send `"sources_only": true` to get cited answers only. Questions about Open Verse Ai itself never go to the model.

```
site/  (GitHub Pages, static)  ──HTTPS──▶  worker/  (Cloudflare Worker + D1)
  index.html  landing                       POST /v1/keys        create key (hash stored)
  docs.html   API reference                 GET  /v1/me          usage
  portal.html create/try/revoke keys        POST /v1/ask         auth → rate limit → BM25 retrieval
                                            DELETE /v1/keys/current
knowledge/*.md ──scripts/build-index.mjs──▶ worker/src/knowledge-index.json (bundled into the Worker)
```

## Repo layout

| Path | What |
|---|---|
| `site/` | Static website deployed by `.github/workflows/pages.yml`. Public: no secrets. |
| `worker/` | Cloudflare Worker API, D1 migrations, tests. |
| `scripts/memory/` | Local pipeline for owner-only personal memory. |
| `private/` | Gitignored: raw chat exports, chunks, profile. |
| `knowledge/` | The only source of answers. One chunk per `##`/`###` section. |
| `scripts/build-index.mjs` | Builds the search index from `knowledge/`. |

## Local development

Requires Node 20+.

```bash
cd worker
npm install
cp ../.env.example .dev.vars        # then set IP_SALT=$(openssl rand -hex 32)
npm run db:local                     # apply migrations/ to local D1
npm run dev                          # API on http://localhost:8787
```

In another terminal, serve the site:

```bash
cd site && python3 -m http.server 8080   # open http://localhost:8080/portal.html
```

`site/assets/config.js` points to `http://localhost:8787` automatically on localhost.

Run the tests:

```bash
cd worker && npm test
```

## Deploy

1. **API (Cloudflare):**
   ```bash
   cd worker
   npx wrangler login
   npx wrangler d1 create open-verse-ai     # paste database_id into wrangler.toml
   npm run db:remote                        # applies worker/migrations/ in order
   npx wrangler secret put IP_SALT          # paste output of: openssl rand -hex 32
   npm run deploy
   ```
   Set `ALLOWED_ORIGINS` and `REPO_URL` in `wrangler.toml` to your GitHub Pages origin and repo.
2. **Site (GitHub Pages):** set `API_BASE` in `site/assets/config.js` to your Worker URL, push to `main`, then in the repo's **Settings → Pages** choose **GitHub Actions** as the source.

## Environment variables

| Name | Where | Secret | Purpose |
|---|---|---|---|
| `IP_SALT` | `wrangler secret` / `.dev.vars` | **yes** | Salts IP hashes for key-creation limits |
| `ALLOWED_ORIGINS` | `wrangler.toml` | no | CORS allow-list |
| `REPO_URL` | `wrangler.toml` | no | Builds source links in answers |
| `RATE_PER_MINUTE` | `wrangler.toml` | no | Asks per key per minute (20) |
| `QUOTA_PER_DAY` | `wrangler.toml` | no | Asks per key per UTC day (500) |
| `KEYS_PER_IP_DAY` | `wrangler.toml` | no | New keys per network per UTC day (20; code fallback 3) |
| `GENERAL_ENABLED` | `wrangler.toml` | no | `"false"` turns off Llama answers |
| `AI_MODEL` | `wrangler.toml` | no | Workers AI model id |
| `GENERAL_PER_DAY` | `wrangler.toml` | no | Llama answers per key per UTC day (50) |
| `GENERAL_GLOBAL_PER_DAY` | `wrangler.toml` | no | Llama answers across all keys per day (2000) |
| `AI` binding | `wrangler.toml` `[ai]` | no | Workers AI; no API key needed |
| `PASSKEY_ORIGINS` | `wrangler.toml` | no | Pages allowed to use passkeys (hostname = RP ID) |
| `PASSKEY_ATTEMPTS_PER_HOUR` | `wrangler.toml` | no | Passkey attempts per network per hour (30) |
| `SESSION_HOURS` | `wrangler.toml` | no | Passkey session lifetime (12) |
| `MEMORY_LEARN` | `wrangler.toml` | no | `"false"` stops owner memory from learning |
| `TOOLS_ENABLED` | `wrangler.toml` | no | `"false"` turns off live weather/stock tools (default on) |

## Personal memory (owner only)

Lets Open Verse Ai use your past Claude and Gemini chats, your Google Takeout data (Drive files, **sent** Gmail, Keep, Calendar) and a short profile as background, without sending whole logs.

```
private/exports/  ──build──▶  private/memory/chunks.jsonl  ──upload──▶  D1 memory_fts (FTS5) + memory_profile
(raw, gitignored)   parse → redact → chunk    + private/profile.md (you write it)      ▲ read only for owner keys
```

1. Put exports in `private/exports/` (any layout; unzip Takeout there):
   - Claude: Settings → Privacy → Export data → `conversations.json`
   - Google Takeout (takeout.google.com), select:
     - **My Activity** → formats: **JSON** → keeps `.../Gemini Apps/MyActivity.json`
     - **Drive** → Advanced settings: Documents as **DOCX** or **Plain text** (`.txt .md .html .docx` are read; PDFs and images are skipped)
     - **Mail** → "All Mail data included" → deselect all, select **Sent** (only messages labelled Sent are ever kept; quoted replies and signatures are stripped)
     - **Keep** and **Calendar** (event titles only, grouped per month; locations and attendees dropped)
   - Limit sources with `--sources gmail,drive`; for a non-Gmail mbox pass `--me you@example.com`.
2. `cd worker && npm run memory:build`, then review `private/memory/chunks.jsonl` and `redaction-report.txt`. Add strings that must not be redacted to `private/redact-allow.txt`.
3. Copy `private/profile.draft.md` to `private/profile.md` and rewrite it (≤ ~200 words, no TODOs).
4. `npm run memory:upload -- --remote --yes` (replaces all memory; re-run after new exports).
5. `npm run memory:owner-key -- --remote --label "me"` prints an owner key once.

On owner requests that fall through to Llama, the profile and the top 3 matching chunks (≤ 700 chars each) are added to the prompt as labelled background, and returned in `memory_sources`. Docs and math answers never use memory. `"use_memory": false` turns it off per request. `POST /v1/memory/search` shows what would be retrieved.

Limits: redaction is pattern-based (emails, phones, card numbers, keys/tokens, passwords), so review the chunks; names and street addresses inside text are not removed. Retrieval is keyword-based (FTS5 with stemming), so it can miss paraphrases. Retrieved chunks are sent to Workers AI.

## Models and exact math

| `model` | Model (open weights) | In our tests |
|---|---|---|
| `qwen` (auto, first) | Qwen 3.8 27B, Alibaba | best at math; complete formulas; fastest tool calls |
| `gemma` | Gemma 4 26B, Google | correct on all checks |
| `llama4` | Llama 4 Scout 17B, Meta | correct on all checks |
| `llama` | Llama 3.3 70B, Meta | fast; cut a long math answer short |
| `mistral` | Mistral Small 3.1 24B | fast; wrong on a physics check, so last |

`auto` tries Qwen → Gemma → Llama 4 (max 3 per question); a chosen `model` goes first. Questions with numbers get a `calculate` tool: the model writes the formula, the Worker computes it exactly (`src/math.js`: + − × ÷ ^, sqrt, ln/log, exp, trig, pi, e, …), and results are returned in `calculations`. Not on Workers AI: Mixtral, Phi-3 and NVIDIA Nemotron (these could run on the Mac mini via Ollama later).

## Reading level (all answers)

Default `"style": "simple"`: every answer is written at a 9th-grade level (everyday words, short sentences, technical terms explained in parentheses) without dropping facts, numbers, units, formulas or steps. Docs answers are rewritten by a model (Llama 4 first) and **rejected if any number from the original is missing**, falling back to the original wording (`simplify_skipped`). `original_answer` always carries the exact docs text. `"style": "original"` turns this off.

## Live data tools

Weather and market-price questions skip the docs. Llama picks a tool (`get_weather`, `get_stock_quote`) and its arguments (it fixes typos like "nvidea" → NVDA); the Worker fetches the data (Open-Meteo, Yahoo Finance chart API: free, no keys, Yahoo is unofficial and may be delayed or blocked) and Llama words the answer from it. If the model doesn't call a tool on an obvious live question, the Worker fetches anyway. Answers come back as `mode: "live"` with the raw data in `live_data`. Turn off with `TOOLS_ENABLED = "false"`.

## Memory that learns (owner only)

| You say | It does |
|---|---|
| "remember that I'm in AP Physics 1" | saves a fact |
| "from now on keep answers short" | saves a preference |
| "no, my test is on rotational motion" | saves a correction, linked to the last question |
| "what do you remember about me?" | lists facts |
| "forget that I take Algebra 2" / "forget everything you learned" | removes matching facts / all facts + learned conversations |

Facts go into every owner prompt (≈1,800 chars, newest first). Answered owner questions are saved (redacted) as searchable conversations (`source = 'openverse'`, newest 5,000 kept). Not saved: live data, math, questions about past conversations, "I don't know" answers (they would make memory quote itself). `memory:upload` replaces imported data but keeps facts and learned conversations. Off switch: `MEMORY_LEARN = "false"` or `"use_memory": false` per request.

## Lock screen (PIN + Touch ID)

Every page of the site is behind a lock screen like Command Center's.

- **First time on a device:** paste your owner key and choose an 8-digit PIN. The key is encrypted with AES-GCM using a key from your PIN (PBKDF2-SHA256, 600,000 rounds) and stored **only in that browser** (`localStorage`). It is never published, so the PIN can't be brute-forced from the internet.
- **Unlock:** PIN, or Touch ID / Face ID after tapping **Enable Touch ID** (two taps). Touch ID uses the passkey PRF secret to decrypt the key; browsers without PRF fall back to a non-extractable key kept in that browser.
- **Two-step (PIN + Touch ID):** tap **Turn on two-step** (two taps, then confirm your PIN). The key is then encrypted with `HKDF(PBKDF2(PIN) ‖ PRF(passkey))`, so the PIN alone or the fingerprint alone cannot decrypt it; the old Touch-ID-only shortcut is removed. Needs a browser whose passkeys support PRF (recent Safari, or Chrome with iCloud Keychain / Google Password Manager); otherwise it refuses and the PIN lock stays as is. To turn it off or after losing the passkey: **Forget this device** and set up again with your owner key.
- After 5 wrong PINs the screen waits 30 s, doubling up to 1 h. It auto-locks after 5 minutes idle; the unlocked key lives only in that tab.
- **Forget this device** wipes the saved key and Touch ID from the browser.
- The page HTML itself is public in this repo; what the lock protects is your owner key, and the API keys protect your data.
- The older server-side passkey sign-in (`/v1/passkeys/*`) is switched off (`PASSKEY_ORIGINS = ""`).

## Security model

- Keys: `ova_` + 32 random bytes (base64url), shown once. Only the SHA-256 hash goes in D1.
- Scopes: `POST /v1/keys` only creates `public` keys. `owner` keys come from `scripts/memory/owner-key.mjs` and are the only keys that can read personal memory.
- Auth: `Authorization: Bearer <key>` or `X-API-Key`. Malformed keys are rejected before any DB lookup.
- Abuse: per-key minute rate and daily quota; per-IP (salted-hash) daily cap on key creation.
- CORS is a browser convenience, not access control. The key is the access control.
- Finance answers carry a disclaimer and only explain methods. The model's system prompt forbids trade recommendations.
- Llama answers have their own per-key and global daily caps, so free keys can't run up your Workers AI bill.

## Adding knowledge

Add `knowledge/<topic>.md` with optional front matter:

```markdown
---
title: Control Systems
domain: engineering
disclaimer: optional text appended to answers from this file
---
# Control Systems
## Bode plots
…
```

Then `npm run deploy` (it rebuilds the index). Write full sentences that restate the topic, because retrieval matches words.

## License

[MIT](LICENSE)
