#!/usr/bin/env bash
# End-to-end checks against a deployed Open Verse Ai Worker.
#   scripts/verify-live.sh https://open-verse-ai.<subdomain>.workers.dev [https://<user>.github.io]
# Uses 1 of the 3 daily key creations for your network and revokes that key at the end.
# To reuse an existing key instead (e.g. after hitting the daily key limit):
#   OVA_KEY=ova_... scripts/verify-live.sh <worker-url>
# In that mode usage checks compare before/after deltas and the key is NOT revoked.
# Makes 1 Llama call on Workers AI (the general-answer check).
# Run from the repo root; needs curl, node, and `wrangler login` for the D1 hash check.
set -uo pipefail

API="${1:?usage: verify-live.sh <worker-url> [pages-origin]}"
API="${API%/}"
ORIGIN="${2:-https://commandcenter12.github.io}"
PASS=0; FAIL=0; SKIP=0
skip() { echo "  SKIP  $1"; SKIP=$((SKIP+1)); }
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }
# Evaluates a JS expression over JSON on stdin; skips any non-JSON noise before the first [ or {.
# Prints <invalid JSON> if the body isn't JSON, <missing> if the expression hits an absent field.
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s.slice(Math.max(0,s.search(/[\[{]/))))}catch(e){console.log("<invalid JSON>");return}try{const v=new Function("r","return ("+process.argv[1]+")")(r);console.log(v===undefined||v===null?"<missing>":v)}catch(e){console.log("<missing>")}})' "$1"; }
# Remote D1 query with retries; prints raw output to stderr if it never parses.
d1() {
  local out
  for attempt in 1 2 3; do
    out=$(cd worker && npx wrangler d1 execute open-verse-ai --remote --json --command "$1" 2>&1)
    if [ "$(echo "$out" | jq_ 'Array.isArray(r) && r[0].success')" = "true" ]; then echo "$out"; return; fi
    sleep 2
  done
  echo "  (wrangler output: $(echo "$out" | tail -3 | tr '\n' ' '))" >&2
  echo "$out"
}
ask() { curl -s -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== Deployed version is consistent"
# Right after `wrangler deploy`, some edge locations briefly serve the previous version.
STABLE=""
for attempt in $(seq 1 12); do
  SEEN=$(for i in 1 2 3 4 5; do curl -s "$API/v1/health?r=$RANDOM$i" | jq_ 'r.index.built_at+" "+(r.general?"general":"no-general")'; done | sort -u)
  if [ "$(echo "$SEEN" | wc -l | tr -d ' ')" = 1 ]; then STABLE="$SEEN"; break; fi
  sleep 5
done
if [ -n "$STABLE" ]; then ok "5/5 health reads agree: index built $STABLE"; else bad "versions still mixed after 60s: $(echo $SEEN)"; exit 1; fi

echo "== Keys"
REUSE=0
if [ -n "${OVA_KEY:-}" ]; then
  KEY="$OVA_KEY"; REUSE=1
  if [[ "$KEY" =~ ^ova_[A-Za-z0-9_-]{43}$ ]]; then ok "using existing key ${KEY:0:12}… (OVA_KEY)"; else bad "OVA_KEY is malformed"; exit 1; fi
  skip "POST /v1/keys mint (reusing a key)"
else
  RESP=$(curl -s -X POST "$API/v1/keys" -H 'Content-Type: application/json' -d '{"label":"verify-live"}')
  KEY=$(echo "$RESP" | jq_ 'r.key')
  if [[ "$KEY" =~ ^ova_[A-Za-z0-9_-]{43}$ ]]; then ok "POST /v1/keys minted ${KEY:0:12}…"
  else bad "POST /v1/keys: $RESP"; echo "  Hit the daily key limit? Re-run with OVA_KEY=<an existing key>."; exit 1; fi
  check "response says shown once" "$(echo "$RESP" | jq_ '/only once/.test(r.note)')" "true"
fi
ME0=$(curl -s "$API/v1/me" -H "Authorization: Bearer $KEY")
DAY0=$(echo "$ME0" | jq_ 'r.usage.day.used'); GEN0=$(echo "$ME0" | jq_ 'r.usage.general_day.used')
if [[ ! "$DAY0" =~ ^[0-9]+$ || ! "$GEN0" =~ ^[0-9]+$ ]]; then bad "/v1/me baseline (day=$DAY0 general=$GEN0): $ME0"; exit 1; fi

HASH=$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$KEY")
ROW=$(d1 "SELECT prefix, key_hash, label, (key_hash = '$HASH') AS match, instr(prefix||key_hash||ifnull(label,''), '$KEY') AS plain FROM api_keys WHERE prefix = '${KEY:0:12}'")
check "D1 row stores SHA-256 of the key" "$(echo "$ROW" | jq_ 'r[0].results[0].match')" "1"
check "D1 row does not contain the plaintext key" "$(echo "$ROW" | jq_ 'r[0].results[0].plain')" "0"

echo "== Auth (401)"
check "no key"            "$(code -X POST "$API/v1/ask" -H 'Content-Type: application/json' -d '{"question":"rsi"}')" 401
check "malformed key"     "$(code -X POST "$API/v1/ask" -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{"question":"rsi"}')" 401
check "unknown key"       "$(code -X POST "$API/v1/ask" -H "Authorization: Bearer ova_$(printf 'A%.0s' {1..43})" -H 'Content-Type: application/json' -d '{"question":"rsi"}')" 401
check "X-API-Key accepted" "$(code "$API/v1/me" -H "X-API-Key: $KEY")" 200
if [ "$(curl -s "$API/v1/me" -H "Authorization: Bearer $KEY" | jq_ 'r.scope')" = "owner" ]; then
  skip "memory search 403 (OVA_KEY is an owner key)"
else
  check "public key can't read memory (403)" "$(code -X POST "$API/v1/memory/search" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"question":"my projects"}')" 403
fi

echo "== Bad input (400/413/415) - must not use quota"
check "empty question"   "$(code -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"question":"  "}')" 400
check "invalid JSON"     "$(code 2>/dev/null -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{oops')" 400
check "top_k out of range" "$(code -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"question":"pid","top_k":9}')" 400
check "wrong content type" "$(code -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -d 'question=pid')" 415
check "unknown route"    "$(code "$API/v1/nope")" 404

echo "== Grounded answers (3 successful asks)"
R=$(ask '{"question":"How do I tune a PID controller?"}')
check "PID answered" "$(echo "$R" | jq_ 'r.answered')" "true"
check "PID cites mechatronics doc" "$(echo "$R" | jq_ 'r.sources[0].file')" "knowledge/mechatronics-fundamentals.md"
check "citation URL points at the repo" "$(echo "$R" | jq_ 'r.sources[0].url.startsWith("https://github.com/CommandCenter12/open-verse-ai/blob/main/knowledge/")')" "true"
R=$(ask '{"question":"How is RSI calculated?"}')
check "RSI answered" "$(echo "$R" | jq_ 'r.answered')" "true"
check "finance disclaimer present" "$(echo "$R" | jq_ '/not financial advice/.test(r.disclaimer)')" "true"
R=$(ask '{"question":"What is the best pizza topping in Naples?","sources_only":true}')
check "off-topic + sources_only -> answered:false" "$(echo "$R" | jq_ 'r.answered')" "false"
check "off-topic has no sources" "$(echo "$R" | jq_ 'r.sources.length')" "0"

echo "== Math and general answers (3 more asks, 1 Llama call)"
R=$(ask '{"question":"1+1"}')
check "1+1 -> 2 (mode math)" "$(echo "$R" | jq_ 'r.mode+" "+r.answer')" "math 2"
R=$(ask '{"question":"Does Open Verse Ai have a /v1/translate endpoint?"}')
check "project question never goes to Llama" "$(echo "$R" | jq_ 'r.answered+" "+r.general_unavailable')" "false project_question"
R=$(ask '{"question":"What is the capital of France?"}')
check "general question -> mode general" "$(echo "$R" | jq_ 'r.mode')" "general"
check "general answer mentions Paris" "$(echo "$R" | jq_ '/paris/i.test(r.answer)')" "true"
check "general answer is labelled unverified, no sources" "$(echo "$R" | jq_ 'r.confidence+" "+r.sources.length')" "unverified 0"

echo "== Usage before rate limit"
ME=$(curl -s "$API/v1/me" -H "Authorization: Bearer $KEY")
check "/v1/me day.used +6 (400s not counted)" "$(echo "$ME" | jq_ 'r.usage.day.used')" "$((DAY0 + 6))"
check "/v1/me general_day.used +1" "$(echo "$ME" | jq_ 'r.usage.general_day.used')" "$((GEN0 + 1))"

echo "== Rate limit (429 + Retry-After)"
LIMIT=$(echo "$ME" | jq_ 'r.usage.minute.limit')
USED=$(echo "$ME" | jq_ 'r.usage.minute.used')
OK200=0; GOT429=0; RETRY=""
for i in $(seq 1 $((LIMIT - USED + 5))); do
  H=$(curl -s -o /dev/null -D - -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"question":"gear ratio"}')
  C=$(echo "$H" | head -1 | awk '{print $2}')
  if [ "$C" = 200 ]; then OK200=$((OK200+1)); elif [ "$C" = 429 ]; then GOT429=$((GOT429+1)); RETRY=$(echo "$H" | grep -i '^retry-after' | awk '{print $2}' | tr -d '\r'); fi
done
# The minute window may roll over mid-loop; then fewer 429s appear. Re-run if so.
check "429s after limit" "$GOT429" "5"
if [[ "$RETRY" =~ ^[0-9]+$ ]]; then ok "Retry-After = ${RETRY}s"; else bad "Retry-After missing"; fi

echo "== Usage excludes rejected calls"
ME=$(curl -s "$API/v1/me" -H "Authorization: Bearer $KEY")
check "/v1/me day.used +6 +accepted ($((DAY0 + 6 + OK200)))" "$(echo "$ME" | jq_ 'r.usage.day.used')" "$((DAY0 + 6 + OK200))"
# Range instead of LIKE: D1 rejects LIKE patterns this long ("pattern too complex"). ';' sorts right after ':'.
RAW=$(d1 "SELECT max(count) AS c FROM counters WHERE bucket >= 'ask:d:$HASH:' AND bucket < 'ask:d:$HASH;'")
check "raw D1 day counter (no display clamp)" "$(echo "$RAW" | jq_ 'r[0].results[0].c')" "$((DAY0 + 6 + OK200))"

echo "== CORS"
A=$(curl -s -o /dev/null -D - -X OPTIONS "$API/v1/ask" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin' | awk '{print $2}' | tr -d '\r')
check "Pages origin allowed" "$A" "$ORIGIN"
N=$(curl -s -o /dev/null -D - -X OPTIONS "$API/v1/ask" -H 'Origin: https://evil.example' | grep -ci '^access-control-allow-origin')
check "foreign origin not allowed" "$N" "0"

echo "== Revocation"
if [ "$REUSE" = 1 ]; then
  skip "revocation (won't revoke your OVA_KEY)"
else
  check "DELETE /v1/keys/current" "$(code -X DELETE "$API/v1/keys/current" -H "Authorization: Bearer $KEY")" 200
  check "revoked key -> 401" "$(code "$API/v1/me" -H "Authorization: Bearer $KEY")" 401
fi

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
