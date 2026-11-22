# Open Verse Ai

Open-source, **citation-first** Q&A API for mechatronics and stock-analysis methods.
Answers are extracted only from Markdown in [`knowledge/`](knowledge/). When nothing there matches, the API says so (`"answered": false`) instead of guessing.

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
| `worker/` | Cloudflare Worker API, D1 schema, tests. |
| `knowledge/` | The only source of answers. One chunk per `##`/`###` section. |
| `scripts/build-index.mjs` | Builds the search index from `knowledge/`. |

## Local development

Requires Node 20+.

```bash
cd worker
npm install
cp ../.env.example .dev.vars        # then set IP_SALT=$(openssl rand -hex 32)
npm run db:local                     # create tables in local D1
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
   npm run db:remote
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
| `KEYS_PER_IP_DAY` | `wrangler.toml` | no | New keys per network per day (3) |

## Security model

- Keys: `ova_` + 32 random bytes (base64url), shown once. Only the SHA-256 hash goes in D1.
- Auth: `Authorization: Bearer <key>` or `X-API-Key`. Malformed keys are rejected before any DB lookup.
- Abuse: per-key minute rate and daily quota; per-IP (salted-hash) daily cap on key creation.
- CORS is a browser convenience, not access control. The key is the access control.
- Finance answers carry a disclaimer and only explain methods. The API never recommends trades.

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
