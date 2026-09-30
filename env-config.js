/** Shared env parsing (no dotenv — catalog image uses platform env only). */

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function buildConfig() {
  const mode = (process.env.PRICEWATCH_MODE || "full").toLowerCase();
  const isCatalog = mode === "catalog";
  const refreshIntervalSec = intEnv("REFRESH_INTERVAL_SEC", 3600);

  return {
    mode,
    isCatalog,
    port: intEnv("PORT", isCatalog ? 7000 : 3001),
    dataDir: process.env.DATA_DIR || ".",
    refreshIntervalSec,
    refreshIntervalMs: refreshIntervalSec * 1000,
    retryTickMs: 5 * 60 * 1000,
    retryDelayMs: 6 * 60 * 60 * 1000,
    maxRetries: 3,
    verifyTimeoutMs: 10_000,
    deliveryTimeoutMs: 10_000,
    httpTimeoutMs: intEnv("HTTP_TIMEOUT_MS", 30_000),
    userAgent:
      process.env.USER_AGENT ||
      (isCatalog ? "PriceWatch-Catalog/1.0" : "PriceWatchBot/2.0"),
    allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === "true",
  };
}
