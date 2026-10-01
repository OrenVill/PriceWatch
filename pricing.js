/**
 * Pure pricing logic: fetch the LiteLLM catalog, classify models by provider,
 * convert to $/1M tokens, and diff two snapshots.
 */

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** First-party / major model vendors tracked by PriceWatch. */
export const PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "meta",
  "mistral",
  "deepseek",
  "qwen",
  "xai",
  "cohere",
  "perplexity",
  "amazon",
];

export function round(n) {
  return Math.round(n * 10000) / 10000;
}

/** Parse comma-separated provider names; empty/missing means all PROVIDERS. */
export function parseProviderList(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [...PROVIDERS];
  }
  const list = String(raw)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const invalid = list.filter((p) => !PROVIDERS.includes(p));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown provider(s): ${invalid.join(", ")}. Valid: ${PROVIDERS.join(", ")}.`,
    );
  }
  if (list.length === 0) {
    throw new Error("providers list must be non-empty.");
  }
  return [...new Set(list)];
}

export function emptyPricing(providers = PROVIDERS) {
  return Object.fromEntries(providers.map((p) => [p, {}]));
}

export function hasPricingModels(pricing) {
  return Object.values(pricing).some((models) => Object.keys(models).length > 0);
}

export function baselineHasModels(baseline) {
  if (!baseline) return false;
  return PROVIDERS.some((p) => baseline[p] && Object.keys(baseline[p]).length > 0);
}

export function classify(model) {
  const lower = model.toLowerCase();
  const base = model.includes("/") ? model.split("/").pop() : model;
  const baseLower = base.toLowerCase();

  if (baseLower.startsWith("claude") || lower.includes("anthropic.claude")) {
    return "anthropic";
  }

  if (
    baseLower.startsWith("gpt-") ||
    /^o[134]/.test(baseLower) ||
    baseLower.startsWith("chatgpt") ||
    lower.includes("openai.gpt")
  ) {
    return "openai";
  }

  if (baseLower.startsWith("gemini") || baseLower.startsWith("gemma")) {
    return "gemini";
  }

  if (
    baseLower.startsWith("llama") ||
    lower.includes("meta.llama") ||
    lower.startsWith("meta/llama")
  ) {
    return "meta";
  }

  if (/^(mistral|mixtral|codestral|pixtral|ministral)/i.test(baseLower)) {
    return "mistral";
  }

  if (baseLower.startsWith("deepseek")) return "deepseek";
  if (baseLower.startsWith("qwen")) return "qwen";
  if (baseLower.startsWith("grok")) return "xai";
  if (baseLower.startsWith("command") || baseLower.startsWith("cohere")) {
    return "cohere";
  }
  if (baseLower.startsWith("sonar")) return "perplexity";

  if (
    baseLower.startsWith("nova") ||
    baseLower.startsWith("titan") ||
    lower.includes("amazon.nova") ||
    lower.includes("amazon.titan")
  ) {
    return "amazon";
  }

  return null;
}

export function parsePricing(data, options = {}) {
  const providers =
    options.providers && options.providers.length > 0
      ? options.providers
      : [...PROVIDERS];
  const wanted = new Set(providers);
  const result = emptyPricing(providers);

  for (const [model, info] of Object.entries(data)) {
    if (!info.input_cost_per_token || !info.output_cost_per_token) continue;
    const provider = classify(model);
    if (!provider || !wanted.has(provider)) continue;
    const entry = {
      input: round(info.input_cost_per_token * 1_000_000),
      output: round(info.output_cost_per_token * 1_000_000),
    };
    if (info.cache_read_input_token_cost) {
      entry.cachedInput = round(info.cache_read_input_token_cost * 1_000_000);
    }
    result[provider][model] = entry;
  }
  return result;
}

export async function fetchPricing(options = {}) {
  const {
    url = LITELLM_URL,
    timeoutMs = 30_000,
    userAgent = "PriceWatchBot/2.0",
    providers,
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
  const pricing = parsePricing(data, { providers });
  if (!hasPricingModels(pricing)) {
    throw new Error("No models parsed from LiteLLM JSON.");
  }
  return pricing;
}

/** Build the GET /prices response body from parsed provider maps. */
export function buildPricesPayload(pricing, lastUpdated) {
  return { ...pricing, lastUpdated };
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

export function diffAllPricing(prev, now, providers = PROVIDERS) {
  const changes = [];
  for (const provider of providers) {
    changes.push(...diffPricing(provider, prev[provider] || {}, now[provider] || {}));
  }
  return changes;
}

export function modelCounts(pricing, providers = PROVIDERS) {
  return Object.fromEntries(
    providers.map((p) => [p, Object.keys(pricing[p] || {}).length]),
  );
}
