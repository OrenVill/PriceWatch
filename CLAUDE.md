# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
node server.js       # start the service (production)
node --watch server.js  # start with auto-restart on file changes (dev)
npm test             # run the unit test suite (node --test)
```

Verify webhook behavior with a local receiver (see README).

## Architecture

`server.js` is a long-running Express service. On boot and every hour it fetches the
LiteLLM community JSON, diffs it against `pricing-baseline.json`, and POSTs a signed
`change` event to every active subscriber whose provider filter matches. Failed
deliveries are queued in `retry-queue.json` and retried every 5 minutes (6h apart,
up to 3 retries, then dropped).

Logic is split into focused modules:
- `pricing.js` — fetch, classify (gpt-/o1/o3/o4/chatgpt → openai; claude → anthropic), diff.
- `store.js` — atomic JSON persistence (subscribers, retry queue, baseline) behind an in-process mutex.
- `delivery.js` — HMAC-SHA256 signing, signed POST with timeout, verification ping, retry decision.
- `url-guard.js` — SSRF safeguard rejecting localhost/private webhook targets.

Prices are stored as $/1M tokens (raw cost × 1_000_000), rounded to 4 decimals.

## Key constraints

- ES modules (`"type": "module"`). Use `import`/`export`; no `require()`.
- No database — state is JSON files in `DATA_DIR`. They survive restarts; absolute
  `nextAttempt` timestamps mean queued retries resume after a restart.
- No email. Delivery is webhooks only.
- Endpoints: `POST /subscribe`, `DELETE /subscribe/:id` (Bearer secret), `GET /health`.
  `/health` is unauthenticated.
- Subscribers verify URL ownership via a confirmation ping (2xx + challenge echo) before activation.
- Webhook POSTs are signed: `X-PriceWatch-Signature: sha256=<hmac>` over the raw body.
