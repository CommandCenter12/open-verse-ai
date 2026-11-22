---
title: Open Verse Ai API
domain: project
---
# Open Verse Ai API

## Overview
Open Verse Ai is a retrieval-only question answering API. It answers questions by searching the Markdown documents in the knowledge folder of the repository and returning the most relevant sentences with citations. It does not use a large language model, so it never invents an answer: if no document covers the question, the response has answered set to false.

## Getting an API key
Create a key with POST /v1/keys, optionally sending a JSON body with a label of up to 60 characters. The response contains the full key, which starts with ova_. The key is shown only once. The server stores only a SHA-256 hash of the key, so a lost key cannot be recovered; create a new one instead. Each network can create at most 3 keys per UTC day by default.

## Authentication
Send the API key in the Authorization header as Bearer token, for example Authorization: Bearer ova_yourkey. The X-API-Key header is also accepted. A missing key returns HTTP 401 with error code missing_api_key. A malformed, unknown or revoked key returns HTTP 401 with error code invalid_api_key.

## Asking a question
Send POST /v1/ask with a JSON body containing question, a string of 3 to 500 characters. The optional top_k field is an integer from 1 to 5 that sets how many sources to consider, default 3. The response contains answered, answer, confidence, sources and sometimes a disclaimer. Each source has a title, section, file, url, score and excerpt.

## Rate limits and quotas
Each key may make 20 requests to /v1/ask per minute and 500 per UTC day by default. Exceeding the per minute limit returns HTTP 429 with error code rate_limited. Exceeding the daily quota returns HTTP 429 with error code quota_exceeded. Both include a Retry-After header in seconds. Successful responses include X-RateLimit-Limit and X-RateLimit-Remaining headers.

## Checking usage
GET /v1/me with your key returns the key prefix, label, creation time, last used time and current usage for the minute and day windows.

## Revoking a key
DELETE /v1/keys/current revokes the key used to authenticate the request. Revoked keys stop working immediately.

## Error format
Every error response is JSON shaped as an error object with a code and a message. Common codes are empty_question, question_too_long, invalid_json, unsupported_media_type, missing_api_key, invalid_api_key, rate_limited, quota_exceeded and not_found.

## Adding knowledge
To teach Open Verse Ai a new topic, add a Markdown file to the knowledge folder. Each second or third level heading becomes one searchable section. Rebuild the index with npm run build:index in the worker folder and redeploy.
