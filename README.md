# PriceWatch

Event-driven AI pricing service — clients register a webhook and receive signed pricing-change pushes.

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
  -d '{"url": "https://your-app.example.com/pricewatch", "providers": ["openai", "anthropic"]}'
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
| `PORT` | `3001` | Port the service listens on |
| `DATA_DIR` | `.` | Directory for JSON state files (`subscribers.json`, `retry-queue.json`, `pricing-baseline.json`) |
| `ALLOW_PRIVATE_URLS` | `false` | Set to `true` to allow `localhost`/private-IP webhook targets (local testing only) |
