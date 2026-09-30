import { test } from "node:test";
import assert from "node:assert/strict";
import { round, classify, parsePricing, diffPricing } from "../pricing.js";

test("round keeps 4 decimal places", () => {
  assert.equal(round(2.123456), 2.1235);
  assert.equal(round(0.00005), 0.0001);
});

test("classify routes by prefix", () => {
  assert.equal(classify("gpt-4o"), "openai");
  assert.equal(classify("o1-preview"), "openai");
  assert.equal(classify("o3-mini"), "openai");
  assert.equal(classify("o4-x"), "openai");
  assert.equal(classify("chatgpt-4o-latest"), "openai");
  assert.equal(classify("claude-3-5-sonnet"), "anthropic");
  assert.equal(classify("gemini-pro"), null);
});

test("parsePricing splits providers and converts to $/1M", () => {
  const raw = {
    "gpt-4o": { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
    "claude-3-5-sonnet": { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 },
    "gemini-pro": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    "broken": { input_cost_per_token: 0 },
  };
  const { openai, anthropic } = parsePricing(raw);
  assert.deepEqual(openai, { "gpt-4o": { input: 2.5, output: 10 } });
  assert.deepEqual(anthropic, { "claude-3-5-sonnet": { input: 3, output: 15 } });
});

test("parsePricing includes cachedInput when LiteLLM provides cache read cost", () => {
  const raw = {
    "claude-x": {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
      cache_read_input_token_cost: 3e-7,
    },
  };
  const { anthropic } = parsePricing(raw);
  assert.deepEqual(anthropic["claude-x"], { input: 3, output: 15, cachedInput: 0.3 });
});

test("diffPricing detects new, removed, and changed models", () => {
  const prev = { "gpt-4o": { input: 2.5, output: 10 }, "gpt-old": { input: 1, output: 2 } };
  const now = { "gpt-4o": { input: 2, output: 10 }, "gpt-new": { input: 5, output: 6 } };
  const changes = diffPricing("openai", prev, now);
  const byType = Object.fromEntries(changes.map(c => [c.type, c]));
  assert.equal(byType.PRICE_CHANGE.model, "gpt-4o");
  assert.deepEqual(byType.PRICE_CHANGE.now, { input: 2, output: 10 });
  assert.equal(byType.NEW_MODEL.model, "gpt-new");
  assert.equal(byType.REMOVED_MODEL.model, "gpt-old");
});
