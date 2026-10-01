# PriceWatch

Event-driven AI pricing service — clients register a webhook and receive signed pricing-change pushes.

**Catalog mode** is a minimal deployment that only serves OpenAI, Anthropic, and Gemini model pricing over HTTP (no subscriptions or outbound webhooks). See [Catalog mode](#catalog-mode) below.

---

## Run

```bash
npm install
cp .env.example .env
node server.js
```

Development (auto-restart on save):

```bash
node --watch server.js
```

Test suite:

```bash
npm test
```

---

## Register a webhook

Send a `POST /subscribe` with the URL you want to receive events and an optional list of providers to filter on:

```bash
curl -X POST http://localhost:3001/subscribe \
  -H "Content-Type: application/json" \
  -d '{"url": "https://your-app.example.com/pricewatch", "providers": ["openai", "anthropic", "gemini"]}'
```

The response is `201 Created` and includes the subscriber `id`:

```json
{
  "id": "sub_abc123",
  "status": "pending"
}
```

---

## Verification ping

Before the subscription becomes active, PriceWatch sends a `POST` to your URL with a body like:

```json
{
  "type": "verification",
  "challenge": "rand-hex-value",
  "secret": "your-signing-secret"
}
```

Your receiver **must** respond with `2xx` and echo the challenge:

```json
{ "challenge": "rand-hex-value" }
```

The `secret` in the ping body is your signing key — store it securely. Once the ping succeeds, the subscription becomes active and price-change events will be delivered.

---

## Verify a delivery

Every event POST includes an `X-PriceWatch-Signature` header:

```
X-PriceWatch-Signature: sha256=<hmac>
```

The HMAC is computed as HMAC-SHA256 over the **raw request body**, keyed by your `secret`. Verify it in your receiver before trusting the payload:

```js
import crypto from "crypto";

function verifySignature(rawBody, secret, signatureHeader) {
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
```

---

## Unsubscribe

```bash
curl -X DELETE http://localhost:3001/subscribe/<id> \
  -H "Authorization: Bearer <secret>"
```

---

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/subscribe` | none | Register a webhook URL |
| `DELETE` | `/subscribe/:id` | `Bearer <secret>` | Remove a subscription |
| `GET` | `/health` | none | Service status |

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PRICEWATCH_MODE` | `full` | `full` — webhook push service; `catalog` — read-only price API |
| `PORT` | `3001` (`7000` in catalog) | Port the service listens on |
| `DATA_DIR` | `.` | Directory for JSON state files (`subscribers.json`, `retry-queue.json`, `pricing-baseline.json`) |
| `ALLOW_PRIVATE_URLS` | `false` | Set to `true` to allow `localhost`/private-IP webhook targets (local testing only) |

---

## Catalog mode

Run a stateless in-cluster price catalog (LiteLLM source, OpenAI + Anthropic only). Prefer **`catalog-server.js`** — it does not load Express, subscribers, or webhook code:

```bash
node catalog-server.js
# or
npm run start:catalog
# or
node cli.js serve --mode=catalog
```

`PRICEWATCH_MODE=catalog node server.js` also works but loads the full app module graph; use `catalog-server.js` in production sidecars.

### Resource profile

Designed for **very low** cluster cost:

- **No npm dependencies** in the catalog Docker image (`node:http` only).
- **Pre-serialized** `/prices` JSON (no `JSON.stringify` per request).
- **Hourly** LiteLLM refresh by default (set `REFRESH_INTERVAL_SEC=0` for startup-only fetch).
- Suggested Kubernetes requests: **50m CPU / 64Mi** memory (see `deploy/kubernetes/pricewatch-catalog.yaml`).
- Container sets `NODE_OPTIONS=--max-old-space-size=64` to cap V8 heap.

### Endpoints (catalog)

| Method | Path | Description |
|---|---|---|
| `GET` | `/prices` | OpenAI and Anthropic models ($/1M tokens) plus `lastUpdated` |
| `GET` | `/healthz` | Liveness/readiness (`{ "ok": true, "mode": "catalog" }`) |

`POST /subscribe` and `DELETE /subscribe/:id` return **404**.

### Catalog environment variables

| Variable | Default | Description |
|---|---|---|
| `PRICEWATCH_MODE` | `catalog` when using catalog image | Must be `catalog` |
| `PORT` | `7000` | HTTP port |
| `REFRESH_INTERVAL_SEC` | `3600` | Periodic LiteLLM refresh; `0` = refresh on startup only |
| `HTTP_TIMEOUT_MS` | `30000` | Upstream fetch timeout |
| `USER_AGENT` | `PriceWatch-Catalog/1.0` | User-Agent for LiteLLM fetch |

On refresh failure, the last successful catalog is kept; `/healthz` stays `200` even if data is stale.

### Example

```bash
curl -sS http://localhost:7000/prices | jq '.openai | keys | length, .anthropic | keys | length, .gemini | keys | length'
curl -sS http://localhost:7000/healthz
```

### Container image

Build the catalog-only image:

```bash
docker build -f Dockerfile.catalog -t pricewatch-catalog:local .
docker run --rm -p 7000:7000 -e REFRESH_INTERVAL_SEC=3600 pricewatch-catalog:local
```

The catalog image is **Alpine + four JS files** (no `npm install`, no Express).

CI publishes `ghcr.io/<owner>/<repo>-catalog` on pushes to `master` and version tags (see `.github/workflows/catalog-image.yml`).
