# PriceWatch

PriceWatch tracks OpenAI and Anthropic model pricing from the
[LiteLLM community JSON](https://github.com/BerriAI/litellm) and pushes
signed webhook notifications to registered subscribers whenever prices change.

## Architecture

PriceWatch is split into two independent pieces that share state through an
AWS S3 bucket (`subscribers.json` and `prices.json`).

### 1. Registration service (`registration-service/`)

A small always-on Express server. Its only job is to maintain the subscriber
list. It does not fetch prices and does not run on a timer.

### 2. PriceWatch cronjob (`cronjob/`)

A short-lived Node script that runs every 6 hours (via Kubernetes `CronJob`).
It fetches the latest pricing, diffs against the previous snapshot in S3,
pushes signed webhooks to all subscribers, retries failures with exponential
backoff, and exits.

### Shared storage

Both pieces read and write the same two files in S3:

- `subscribers.json` — array of registered subscribers
- `prices.json` — last known pricing snapshot

Shared helpers live in [lib/s3.js](lib/s3.js).

## Endpoints (registration service)

All write endpoints require the `X-Api-Key` header.

### `POST /subscribe`

```json
{
  "appName": "My App",
  "webhookUrl": "https://myapp.example.com/webhooks/pricewatch",
  "webhookSecret": "long-random-string",
  "contactEmail": "ops@myapp.example.com"
}
```

Responses:
- `201` — registered
- `400` — missing fields
- `401` — bad API key
- `409` — `webhookUrl` already registered

### `DELETE /unsubscribe`

```json
{ "webhookUrl": "https://myapp.example.com/webhooks/pricewatch" }
```

### `GET /health`

Public. Returns `{ status, registeredSubscribers, timestamp }`.

## Webhook payload

The cronjob POSTs the following JSON to each subscriber's `webhookUrl`:

```json
{
  "event": "price.update",
  "timestamp": "2026-04-15T12:00:00.000Z",
  "changes": [
    {
      "provider": "openai",
      "model": "gpt-4o",
      "type": "PRICE_CHANGE",
      "prev": { "input": 2.5, "output": 10.0 },
      "now":  { "input": 2.0, "output": 8.0 }
    }
  ],
  "prices": {
    "openai":    { "gpt-4o": { "input": 2.0, "output": 8.0 } },
    "anthropic": { "claude-3-5-sonnet-20241022": { "input": 3.0, "output": 15.0 } }
  }
}
```

Change `type` is one of `NEW_MODEL`, `REMOVED_MODEL`, or `PRICE_CHANGE`.
Price changes smaller than 1% are filtered out as rounding noise.

### Signature verification

Each request carries an `X-PriceWatch-Signature` header — an HMAC-SHA256 hex
digest of the raw request body using the `webhookSecret` you registered with.

```js
import crypto from "crypto";

function verify(req, secret) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)          // raw body string, not JSON.parse'd
    .digest("hex");
  const got = req.header("X-PriceWatch-Signature") || "";
  return expected.length === got.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}
```

### Retry & removal policy

- Each push has a 10-second timeout.
- Failed pushes retry 3 times with exponential backoff: 1 min, 5 min, 15 min.
- After 3 consecutive failures, the subscriber is removed and an email is
  sent to `contactEmail`.

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `PRICEWATCH_API_KEY` | registration, cronjob | Shared API key for `/subscribe` and `/unsubscribe` |
| `AWS_ACCESS_KEY_ID` | both | AWS credentials |
| `AWS_SECRET_ACCESS_KEY` | both | AWS credentials |
| `AWS_REGION` | both | AWS region of the S3 bucket |
| `S3_BUCKET_NAME` | both | Bucket holding `subscribers.json` and `prices.json` |
| `PORT` | registration | HTTP port (default `3001`) |
| `APP_NAME` | cronjob | Display name used in email `From` |
| `EMAIL_FROM_ADDRESS` | cronjob | `From` address for outgoing email |
| `EMAIL_TO` | cronjob | Owner alert recipient |
| `EMAIL_USER` | cronjob | SMTP username (Gmail) |
| `EMAIL_PASSWORD` | cronjob | SMTP app password |

See [.env.example](.env.example).

## Local development

```bash
# Registration service
cd registration-service && npm install && npm start

# Cronjob (one-off run)
cd cronjob && npm install && npm start
```

## Deployment

Both pieces ship as separate images to GitHub Container Registry:

- `ghcr.io/orenvill/pricewatch-registration:latest`
- `ghcr.io/orenvill/pricewatch-cronjob:latest`

Images are built and pushed by
[.github/workflows/docker.yml](.github/workflows/docker.yml) on every push to
`master`.

### Kubernetes

Create the shared secret:

```bash
kubectl create secret generic pricewatch-secrets --from-env-file=.env
```

Apply manifests:

```bash
kubectl apply -f k8s/deployment.yaml \
              -f k8s/service.yaml \
              -f k8s/ingress.yaml \
              -f k8s/cronjob.yaml
```

The cronjob runs on the schedule `0 */6 * * *` (every 6 hours).
