# PriceWatch — AI Pricing Microservice

A lightweight REST API that serves cached OpenAI and Anthropic model pricing to any app. Refreshes from LiteLLM every hour and emails you when prices change.

---

## Setup

```bash
npm install
cp .env.example .env
# fill in your .env values
node server.js
```

---

## API Endpoints


| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Service status + cache info (no auth) |
| GET | `/prices` | All models (OpenAI + Anthropic) |
| GET | `/prices/openai` | OpenAI models only |
| GET | `/prices/anthropic` | Anthropic models only |
| GET | `/prices/model/:model` | Single model lookup |

### Example requests

```bash
# Health check
curl http://localhost:3001/health

# All prices
curl http://localhost:3001/prices

# Single model
curl http://localhost:3001/prices/model/gpt-4o
```

### Example response — single model

```json
{
  "model": "gpt-4o",
  "provider": "openai",
  "input": 2.5,
  "output": 10,
  "lastUpdated": "2026-04-08T09:00:00.000Z"
}
```

---

## Calling PriceWatch from your app

```js
const PRICEWATCH_URL = "http://localhost:3001";

// Get price for a single model
async function getModelPrice(model) {
  const res = await fetch(`${PRICEWATCH_URL}/prices/model/${model}`, {
  });
  if (!res.ok) throw new Error(`PriceWatch error: ${res.status}`);
  return res.json(); // { model, provider, input, output, lastUpdated }
}

// Get all prices
async function getAllPrices() {
  const res = await fetch(`${PRICEWATCH_URL}/prices`, {
  });
  if (!res.ok) throw new Error(`PriceWatch error: ${res.status}`);
  return res.json(); // { openai: {...}, anthropic: {...}, lastUpdated }
}

// Calculate cost for a request
const price = await getModelPrice("gpt-4o");
const cost = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
```

---

## Environment variables

| Variable | Description |
|---|---|
| `APP_NAME` | Display name in email alerts (e.g. `PriceWatch`) |
| `EMAIL_FROM_ADDRESS` | Gmail address to send alerts from |
| `EMAIL_TO` | Where alerts get delivered |
| `EMAIL_USER` | Gmail SMTP login (same as FROM) |
| `EMAIL_PASSWORD` | Gmail App Password — see below |
| `PORT` | Port to run on (default: `3001`) |

### Getting a Gmail App Password

1. Enable 2-Step Verification:
   👉 https://myaccount.google.com/signinoptions/two-step-verification

2. Generate an App Password:
   👉 https://myaccount.google.com/apppasswords

3. Type any name (e.g. `PriceWatch`) and click **Create**

4. Copy the 16-character password and paste it into `.env` as `EMAIL_PASSWORD` with no spaces

---



## How it works

1. On boot, fetches all OpenAI + Anthropic model prices from [LiteLLM community JSON](https://github.com/BerriAI/litellm)
2. Serves prices instantly from memory — no database needed
3. Refreshes the cache every hour in the background
4. If any price changes — sends you a styled HTML email alert automatically