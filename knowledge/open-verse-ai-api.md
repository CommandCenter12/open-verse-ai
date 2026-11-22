---
title: Open Verse Ai API
domain: project
---
# Open Verse Ai API

## Overview
Open Verse Ai is a question answering API. It answers questions in three ways, reported in the mode field of each response. Mode math computes plain arithmetic such as 1+1 exactly, without any AI model. Mode docs searches the Markdown documents in the knowledge folder of the repository and returns the most relevant sentences with citations. Mode general is used only when no document covers the question: a Llama model on Cloudflare Workers AI writes a short answer that has no citations and is marked unverified. If none of these apply, the response has answered set to false and mode none.

## General answers
General answers come from a Llama language model, not from the knowledge base, so they can be wrong and carry no sources. They are never used for questions about Open Verse Ai itself, its API, endpoints, keys or limits; those are answered from these docs or not at all. Each key can get 50 general answers per UTC day by default. Send sources_only set to true in the request body to disable general answers and get only cited answers from the knowledge base. When a general answer is not available, the response includes general_unavailable with the reason, such as sources_only, project_question, general_quota_exceeded, disabled or error.

## Getting an API key
Create a key with POST /v1/keys, optionally sending a JSON body with a label of up to 60 characters. The response contains the full key, which starts with ova_. The key is shown only once. The server stores only a SHA-256 hash of the key, so a lost key cannot be recovered; create a new one instead. Each network can create at most 20 keys per UTC day. Failed attempts over the limit also count toward it.

## Authentication
Send the API key in the Authorization header as Bearer token, for example Authorization: Bearer ova_yourkey. The X-API-Key header is also accepted. A missing key returns HTTP 401 with error code missing_api_key. A malformed, unknown or revoked key returns HTTP 401 with error code invalid_api_key.

## Asking a question
Send POST /v1/ask with a JSON body containing question, a string of 3 to 500 characters. The optional top_k field is an integer from 1 to 5 that sets how many sources to consider, default 3. The optional sources_only field, true or false, turns off general answers. The response contains answered, mode, answer, confidence, sources and sometimes a note or disclaimer. Each source has a title, section, file, url, score and excerpt.

## Owner keys and personal memory
Keys created with POST /v1/keys are public keys. The project owner can also hold an owner key, which is created only by a local script and cannot be created through the API. Only owner keys can use personal memory, a private store built from the owner's past AI chats, Google Drive files, sent emails, Keep notes, calendar and a profile. For owner keys, general answers may include that background and list it in memory_sources with references M1 to M3; set use_memory to false to leave it out. POST /v1/memory/search shows which memory would be used and returns HTTP 403 with error code owner_only for public keys.

## Passkey sign-in
The owner can sign in with a passkey such as Touch ID, Face ID or Windows Hello instead of pasting the owner key. A passkey is registered once from the API key portal using the owner key. Signing in with it returns a session token starting with ovs_ that works like the owner key for 12 hours. A session cannot register or delete passkeys or revoke the owner key; those need the owner key itself. DELETE /v1/sessions/current signs out. Passkeys only work from the portal's web address, and every sign-in requires the fingerprint or face check.

## Rate limits and quotas
Each key may make 20 requests to /v1/ask per minute and 500 per UTC day by default. Exceeding the per minute limit returns HTTP 429 with error code rate_limited. Exceeding the daily quota returns HTTP 429 with error code quota_exceeded. Both include a Retry-After header in seconds. Successful responses include X-RateLimit-Limit and X-RateLimit-Remaining headers.

## Checking usage
GET /v1/me with your key returns the key prefix, scope (public or owner), label, creation time, last used time and current usage for the minute window, the day window and general answers per day. Requests rejected with HTTP 429 are not counted.

## Revoking a key
DELETE /v1/keys/current revokes the key used to authenticate the request. Revoked keys stop working immediately.

## Error format
Every error response is JSON shaped as an error object with a code and a message. Common codes are empty_question, question_too_long, invalid_json, unsupported_media_type, missing_api_key, invalid_api_key, rate_limited, quota_exceeded and not_found.

## Adding knowledge
To teach Open Verse Ai a new topic, add a Markdown file to the knowledge folder. Each second or third level heading becomes one searchable section. Rebuild the index with npm run build:index in the worker folder and redeploy.
