#!/usr/bin/env bash
# End-to-end checks against a deployed Open Verse Ai Worker.
#   scripts/verify-live.sh https://open-verse-ai.<subdomain>.workers.dev [https://<user>.github.io]
# Uses 1 of the 3 daily key creations for your network and revokes that key at the end.
# Run from the repo root; needs curl, node, and `wrangler login` for the D1 hash check.
set -uo pipefail

API="${1:?usage: verify-live.sh <worker-url> [pages-origin]}"
API="${API%/}"
ORIGIN="${2:-https://commandcenter12.github.io}"
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected $3, got $2)"; fi; }
jq_() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=new Function("r","return ("+process.argv[1]+")")(JSON.parse(s));console.log(v===undefined?"":v)}catch(e){console.log("<parse error>")}})' "$1"; }
ask() { curl -s -X POST "$API/v1/ask" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== Keys"
RESP=$(curl -s -X POST "$API/v1/keys" -H 'Content-Type: application/json' -d '{"label":"verify-live"}')
KEY=$(echo "$RESP" | jq_ 'r.key')
if [[ "$KEY" =~ ^ova_[A-Za-z0-9_-]{43}$ ]]; then ok "POST /v1/keys minted ${KEY:0:12}…"; else bad "POST /v1/keys: $RESP"; exit 1; fi
check "response says shown once" "$(echo "$RESP" | jq_ '/only once/.test(r.note)')" "true"

HASH=$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$KEY")
ROW=$(cd worker && npx wrangler d1 execute open-verse-ai --remote --json \
  --command "SELECT prefix, key_hash, label, (key_hash = '$HASH') AS match, instr(prefix||key_hash||ifnull(label,''), '$KEY') AS plain FROM api_keys WHERE prefix = '${KEY:0:12}'" 2>/dev/null)
check "D1 row stores SHA-256 of the key" "$(echo "$ROW" | jq_ 'r[0].results[0].match')" "1"
check "D1 row does not contain the plaintext key" "$(echo "$ROW" | jq_ 'r[0].results[0].plain')" "0"

echo "== Auth (401)"
check "no key"            "$(code -X POST "$API/v1/ask" -H 'Content-Type: application/json' -d '{"question":"rsi"}')" 401
check "malformed key"     "$(code -X POST "$API/v1/ask" -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{"question":"rsi"}')" 401
check "unknown key"       "$(code -X POST "$API/v1/ask" -H "Authorization: Bearer ova_$(printf 'A%.0s' {1..43})" -H 'Content-Type: application/json' -d '{"question":"rsi"}')" 401
check "X-API-Key accepted" "$(code "$API/v1/me" -H "X-API-Key: $KEY")" 200

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
R=$(ask '{"question":"What is the best pizza topping in Naples?"}')
check "off-topic -> answered:false" "$(echo "$R" | jq_ 'r.answered')" "false"
check "off-topic has no sources" "$(echo "$R" | jq_ 'r.sources.length')" "0"

echo "== Usage before rate limit"
ME=$(curl -s "$API/v1/me" -H "Authorization: Bearer $KEY")
check "/v1/me day.used = 3 (400s not counted)" "$(echo "$ME" | jq_ 'r.usage.day.used')" "3"

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
check "/v1/me day.used = 3 + accepted ($((3 + OK200)))" "$(echo "$ME" | jq_ 'r.usage.day.used')" "$((3 + OK200))"
RAW=$(cd worker && npx wrangler d1 execute open-verse-ai --remote --json --command "SELECT max(count) AS c FROM counters WHERE bucket LIKE 'ask:d:$HASH:%'" 2>/dev/null)
check "raw D1 day counter (no display clamp)" "$(echo "$RAW" | jq_ 'r[0].results[0].c')" "$((3 + OK200))"

echo "== CORS"
A=$(curl -s -o /dev/null -D - -X OPTIONS "$API/v1/ask" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' | grep -i '^access-control-allow-origin' | awk '{print $2}' | tr -d '\r')
check "Pages origin allowed" "$A" "$ORIGIN"
N=$(curl -s -o /dev/null -D - -X OPTIONS "$API/v1/ask" -H 'Origin: https://evil.example' | grep -ci '^access-control-allow-origin')
check "foreign origin not allowed" "$N" "0"

echo "== Revocation"
check "DELETE /v1/keys/current" "$(code -X DELETE "$API/v1/keys/current" -H "Authorization: Bearer $KEY")" 200
check "revoked key -> 401" "$(code "$API/v1/me" -H "Authorization: Bearer $KEY")" 401

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
