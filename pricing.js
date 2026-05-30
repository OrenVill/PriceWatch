/**
 * Pure pricing logic: fetch the LiteLLM catalog, classify models by provider,
 * convert to $/1M tokens, and diff two snapshots.
 */

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export function round(n) {
  return Math.round(n * 10000) / 10000;
}

export function classify(model) {
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("chatgpt")
  ) {
    return "openai";
  }
  if (model.startsWith("claude")) return "anthropic";
  return null;
}

export function parsePricing(data) {
  const openai = {};
  const anthropic = {};
  for (const [model, info] of Object.entries(data)) {
    if (!info.input_cost_per_token || !info.output_cost_per_token) continue;
    const provider = classify(model);
    if (!provider) continue;
    const entry = {
      input: round(info.input_cost_per_token * 1_000_000),
      output: round(info.output_cost_per_token * 1_000_000),
    };
    if (provider === "openai") openai[model] = entry;
    else anthropic[model] = entry;
  }
  return { openai, anthropic };
}

export async function fetchPricing() {
  const res = await fetch(LITELLM_URL, { headers: { "User-Agent": "PriceWatchBot/2.0" } });
  if (!res.ok) throw new Error(`LiteLLM fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const { openai, anthropic } = parsePricing(data);
  if (Object.keys(openai).length === 0 && Object.keys(anthropic).length === 0) {
    throw new Error("No models parsed from LiteLLM JSON.");
  }
  return { openai, anthropic };
}

export function diffPricing(provider, prev, now) {
  const changes = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(now)]);
  for (const model of allKeys) {
    if (!prev[model] && now[model]) {
      changes.push({ provider, model, type: "NEW_MODEL", prev: null, now: now[model] });
    } else if (prev[model] && !now[model]) {
      changes.push({ provider, model, type: "REMOVED_MODEL", prev: prev[model], now: null });
    } else if (
      prev[model] && now[model] &&
      (prev[model].input !== now[model].input || prev[model].output !== now[model].output)
    ) {
      changes.push({ provider, model, type: "PRICE_CHANGE", prev: prev[model], now: now[model] });
    }
  }
  return changes;
}
