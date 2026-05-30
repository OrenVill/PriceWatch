# PriceWatch v2 — Event-Driven Webhook Push

**Date:** 2026-05-30
**Status:** Approved (design)

## Summary

PriceWatch changes from a pull model (clients call `GET /prices`) to a push model:
clients **register a webhook URL once** and the server **POSTs pricing changes to every
registered subscriber** as they are detected. Internally the server still polls the
LiteLLM community JSON hourly; a detected diff against the stored baseline is the
"update received" event that triggers fan-out delivery.

## Decisions (from brainstorming)

- **Delivery:** webhook push. On a change, POST the diff to each subscriber's URL.
- **Retry:** if a delivery fails, retry at 6-hour intervals, up to 3 retries, then give up.
- **Persistence:** JSON files on disk (no database, no new runtime services).
- **Filtering:** subscribers filter by provider (`openai`, `anthropic`, or both).
- **Webhook auth:** HMAC-SHA256 signature header, per-subscriber secret.
- **URL verification:** confirmation ping with a challenge before a subscription activates.
- **Old surface:** push-only. Keep `GET /health`. Remove all `/prices*` read endpoints,
  delete `monitor.js`, remove email/SMTP + `nodemailer`.

## Architecture

The current `server.js` monolith is split into focused modules:

| Module | Responsibility | Depends on |
|---|---|---|
| `pricing.js` | Fetch LiteLLM JSON, classify models (openai/anthropic), diff against a baseline. Pure logic. | native `fetch` |
| `store.js` | Atomic JSON-file persistence for subscribers, retry queue, and pricing baseline. In-process write mutex. | `fs`, `node:crypto` |
| `delivery.js` | HMAC-sign + POST a payload to a URL; verification ping; retry-scheduling decisions. | `node:crypto`, native `fetch` |
| `server.js` | Express wiring (`POST /subscribe`, `DELETE /subscribe/:id`, `GET /health`); boot; hourly detect loop; retry tick. | the three modules above, `express` |

**Removed:** `monitor.js`, all `/prices*` read endpoints, `nodemailer` and every email/HTML
builder, and the `email` block in `config.js`.

**No new npm dependencies.** Uses native `crypto` (HMAC, `randomUUID`), native `fetch`, and `fs`.

## Data model

Three JSON files on disk (atomic write: write to `*.tmp`, then `rename`; all read-modify-write
operations serialized through an in-process mutex).

### `subscribers.json`
```json
{
  "subscribers": [
    {
      "id": "uuid",
      "url": "https://example.com/hook",
      "providers": ["openai", "anthropic"],
      "secret": "hex-32-byte",
      "status": "pending | active",
      "challenge": "token-or-null",
      "createdAt": "iso-8601",
      "verifiedAt": "iso-8601 | null"
    }
  ]
}
```

### `retry-queue.json`
```json
{
  "pending": [
    {
      "deliveryId": "uuid",
      "subscriberId": "uuid",
      "url": "https://example.com/hook",
      "payload": { "type": "change", "...": "change event" },
      "attempts": 1,
      "nextAttempt": "iso-8601",
      "lastError": "string"
    }
  ]
}
```

### `pricing-baseline.json` (unchanged from today)
The diff baseline: `{ openai: {...}, anthropic: {...}, lastUpdated: "iso" }`, prices in
$/1M tokens rounded to 4 decimals.

## Payloads

### Change event (sent on detected diff)
```json
{
  "type": "change",
  "deliveryId": "uuid",
  "timestamp": "iso-8601",
  "changes": [
    { "provider": "openai", "model": "gpt-4o", "type": "PRICE_CHANGE",
      "prev": { "input": 2.5, "output": 10.0 }, "now": { "input": 2.0, "output": 8.0 } }
  ]
}
```
`type` per change is one of `PRICE_CHANGE`, `NEW_MODEL`, `REMOVED_MODEL` (same shape as
the current `diffPricing` output).

### Verification event (sent during registration)
```json
{ "type": "verification", "id": "subscriber-uuid", "challenge": "token", "secret": "hex-32-byte" }
```

### HMAC headers (on every POST)
- `X-PriceWatch-Signature: sha256=<hex>` — HMAC-SHA256 of the raw request body, keyed by the subscriber's `secret`.
- `X-PriceWatch-Event: change | verification`
- `X-PriceWatch-Delivery: <deliveryId>`
- `X-PriceWatch-Timestamp: <iso-8601>`

## Flows

### Registration — `POST /subscribe { url, providers }`
1. Validate: `url` is a well-formed http/https URL; `providers` is a non-empty subset of `["openai", "anthropic"]`.
2. Create subscriber with `status: "pending"`; generate `secret` (32 random bytes, hex) and `challenge` (random token).
3. Synchronously POST a signed `verification` event to `url`. The body carries `challenge` and `secret`.
   The receiver must respond **2xx and echo the challenge** (e.g. `{ "challenge": "<token>" }`) within `verifyTimeoutMs`.
4. On success → set `status: "active"`, `verifiedAt`, clear `challenge`; respond `201 { id, status: "active", providers }`.
5. On failure (non-2xx, wrong/missing echo, timeout, network error) → discard the pending subscriber; respond `400 { error: "verification failed" }`.

Rationale for delivering `secret` in the ping body: the receiver needs it to verify future
HMAC signatures, and the registrant learns its `id` from the HTTP response. When registrant
and receiver are the same system (the common server-to-server case), it ends up with both.

### Unsubscribe — `DELETE /subscribe/:id`
- Requires `Authorization: Bearer <secret>` matching the subscriber's secret.
- On match → remove the subscriber and any of its queued retries; respond `204`.
- On mismatch/not found → `404` (do not reveal existence).

### Detect → push (on boot, then every `refreshIntervalMs`)
1. Fetch current pricing; diff against `pricing-baseline.json`.
2. **First-boot seeding:** if the baseline is empty (fresh install), write the fetched
   prices as the baseline **without** emitting any change events. Only later diffs notify.
3. For each `active` subscriber: filter the change list to the subscriber's `providers`;
   if any changes remain, build a `change` event and POST it (signed).
4. On delivery failure → enqueue in `retry-queue.json` with `attempts: 1`, `nextAttempt: now + retryDelayMs`, `lastError`.
5. Write the new baseline.

### Retry tick (every `retryTickMs`, ~5 min)
1. Load `retry-queue.json`; select items with `nextAttempt <= now`.
2. Re-POST each. On 2xx → remove from queue.
3. On failure → `attempts++`; if `attempts > maxRetries` (3) → drop the item; otherwise set
   `nextAttempt = now + retryDelayMs` and record `lastError`.
- `nextAttempt` is an absolute timestamp, so pending retries survive process restarts.

### Health — `GET /health`
Returns `{ status: "ok", lastUpdated, nextUpdate, models: { openai, anthropic },
subscribers: { active, pending }, retries: { pending } }`. Unauthenticated.

## Configuration

`config.js` loses the `email` block and gains:

| Key | Default | Meaning |
|---|---|---|
| `refreshIntervalMs` | 3_600_000 (1h) | How often to fetch + diff upstream pricing |
| `retryDelayMs` | 21_600_000 (6h) | Delay between delivery attempts |
| `maxRetries` | 3 | Retries after the initial attempt before giving up |
| `retryTickMs` | 300_000 (5m) | How often the retry queue is scanned |
| `verifyTimeoutMs` | 10_000 | Timeout for the registration confirmation ping |
| `deliveryTimeoutMs` | 10_000 | Timeout for each change-event POST |
| `PORT` (env) | 3001 | HTTP port |

## Defaults / behavioral decisions

1. **Retry count:** 1 immediate attempt + up to 3 retries at 6h each, then give up.
2. **First-boot seeding:** an empty baseline is populated silently (no catalog-wide NEW_MODEL flood).
3. **Duplicate URLs:** allowed — each registration is an independent subscriber with its own id/secret.
4. **Email:** fully removed, including the `nodemailer` dependency and SMTP config.
5. **Subscriber health:** an exhausted retry chain drops only that delivery; the subscriber
   stays active. (Auto-disabling chronically failing subscribers is out of scope for v2.)

## Error handling & edge cases

- **Atomic writes:** every JSON file is written to `*.tmp` then renamed; all read-modify-write
  operations go through an in-process async mutex to avoid interleaving registration and delivery writes.
- **Upstream fetch failure:** skip the diff for that cycle (do not treat a failed fetch as
  "all models removed"); log and wait for the next interval. Matches the current monitor's
  defensive behavior.
- **Malformed `retry-queue.json` / `subscribers.json`:** on parse error, log and start from an
  empty structure rather than crashing the server.
- **SSRF safeguard:** reject obviously internal targets at registration (localhost, loopback,
  link-local, RFC-1918 ranges) so the server can't be used to probe internal hosts. Configurable allowance for local testing.
- **Delivery timeouts:** each outbound POST uses `AbortController` with the configured timeout.

## Testing

No test suite exists today. Add `node:test` (built-in) unit tests for the pure logic and a
manual integration check:

- **`pricing`:** classification (prefix rules), `diffPricing` for PRICE_CHANGE / NEW_MODEL /
  REMOVED_MODEL, rounding.
- **`store`:** subscriber CRUD, retry-queue enqueue/scan/drop, atomic write (temp+rename),
  mutex serialization, corrupt-file recovery.
- **`delivery`:** HMAC signature correctness (known vector), header set, retry-scheduling
  decision (`attempts > maxRetries` → drop).
- **Integration (manual):** start a tiny local receiver, register it (confirm verification
  ping + activation), trigger a change, confirm signed POST arrives and verifies; simulate a
  failing receiver and confirm the item lands in the retry queue with the right `nextAttempt`.

## Out of scope (v2)

- Auto-disabling chronically failing subscribers.
- Per-model (vs per-provider) filtering.
- A live streaming transport (SSE/WebSocket) alongside webhooks.
- Any UI / dashboard.
