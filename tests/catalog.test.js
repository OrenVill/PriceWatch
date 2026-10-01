import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePricing, buildPricesPayload } from "../pricing.js";
import {
  createCatalogCache,
  getPricesResponse,
  refreshCatalog,
  createCatalogApp,
} from "../catalog.js";

const FIXTURE = {
  "gpt-4o": {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
  },
  "gpt-4o-mini": {
    input_cost_per_token: 0.00000015,
    output_cost_per_token: 0.0000006,
  },
  "claude-3-5-sonnet-20241022": {
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 3e-7,
  },
  "gemini-pro": {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
  },
};

test("fixture LiteLLM JSON maps to GET /prices shape", () => {
  const pricing = parsePricing(FIXTURE);
  const body = buildPricesPayload(pricing, "2026-09-30T12:00:00.000Z");
  assert.deepEqual(body.openai["gpt-4o"], { input: 2.5, output: 10 });
  assert.deepEqual(body.openai["gpt-4o-mini"], { input: 0.15, output: 0.6 });
  assert.deepEqual(body.anthropic["claude-3-5-sonnet-20241022"], {
    input: 3,
    output: 15,
    cachedInput: 0.3,
  });
  assert.equal(body.lastUpdated, "2026-09-30T12:00:00.000Z");
  assert.deepEqual(body.gemini["gemini-pro"], { input: 1, output: 2 });
  assert.equal(Object.keys(body.openai).length, 2);
  assert.equal(Object.keys(body.anthropic).length, 1);
  assert.equal(Object.keys(body.gemini).length, 1);
});

test("parsePricing with provider filter omits other vendors from payload keys", () => {
  const pricing = parsePricing(FIXTURE, { providers: ["openai"] });
  const body = buildPricesPayload(pricing, "t");
  assert.deepEqual(Object.keys(body).sort(), ["lastUpdated", "openai"]);
  assert.equal(Object.keys(body.openai).length, 2);
});

test("refreshCatalog keeps last good catalog on fetch failure", async () => {
  const cache = createCatalogCache(["openai", "anthropic"]);
  cache.pricing.openai = { "gpt-4o": { input: 1, output: 2 } };
  cache.lastUpdated = "2026-01-01T00:00:00.000Z";

  const ok = await refreshCatalog(cache, {
    url: "http://127.0.0.1:1/unreachable",
    timeoutMs: 50,
    userAgent: "test",
  });
  assert.equal(ok, false);
  assert.deepEqual(cache.pricing.openai, { "gpt-4o": { input: 1, output: 2 } });
  assert.equal(cache.lastUpdated, "2026-01-01T00:00:00.000Z");
});

test("catalog app returns 404 for POST /subscribe", async () => {
  const cache = createCatalogCache(["openai"]);
  const app = createCatalogApp(cache);
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.deepEqual(healthBody, { ok: true, mode: "catalog", providers: ["openai"] });

    const prices = await fetch(`http://127.0.0.1:${port}/prices`);
    assert.equal(prices.status, 200);
    const pricesBody = await prices.json();
    assert.equal(pricesBody.lastUpdated, null);
    assert.deepEqual(Object.keys(pricesBody).sort(), ["lastUpdated", "openai"]);

    const sub = await fetch(`http://127.0.0.1:${port}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(sub.status, 404);
  } finally {
    server.close();
  }
});

test("getPricesResponse mirrors cache", () => {
  const cache = createCatalogCache(["openai", "gemini"]);
  cache.pricing.openai = { a: { input: 1, output: 2 } };
  cache.lastUpdated = "t";
  const body = getPricesResponse(cache);
  assert.deepEqual(body.openai, { a: { input: 1, output: 2 } });
  assert.deepEqual(body.gemini, {});
  assert.equal(body.lastUpdated, "t");
});
