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
  if (model.startsWith("gemini")) return "gemini";
  return null;
}

export function parsePricing(data) {
  const openai = {};
  const anthropic = {};
  const gemini = {};
  for (const [model, info] of Object.entries(data)) {
    if (!info.input_cost_per_token || !info.output_cost_per_token) continue;
    const provider = classify(model);
    if (!provider) continue;
    const entry = {
      input: round(info.input_cost_per_token * 1_000_000),
      output: round(info.output_cost_per_token * 1_000_000),
    };
    if (info.cache_read_input_token_cost) {
      entry.cachedInput = round(info.cache_read_input_token_cost * 1_000_000);
    }
    if (provider === "openai") openai[model] = entry;
    else if (provider === "anthropic") anthropic[model] = entry;
    else gemini[model] = entry;
  }
  return { openai, anthropic, gemini };
}

export async function fetchPricing(options = {}) {
  const {
    url = LITELLM_URL,
    timeoutMs = 30_000,
    userAgent = "PriceWatchBot/2.0",
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`LiteLLM fetch timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(`LiteLLM fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const { openai, anthropic, gemini } = parsePricing(data);
  if (
    Object.keys(openai).length === 0 &&
    Object.keys(anthropic).length === 0 &&
    Object.keys(gemini).length === 0
  ) {
    throw new Error("No models parsed from LiteLLM JSON.");
  }
  return { openai, anthropic, gemini };
}

/** Build the GET /prices response body from parsed provider maps. */
export function buildPricesPayload({ openai, anthropic, gemini, lastUpdated }) {
  return {
    openai,
    anthropic,
    gemini,
    lastUpdated,
  };
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
