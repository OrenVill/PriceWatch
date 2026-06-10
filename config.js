import "dotenv/config";

export const config = {
  port: process.env.PORT || 3001,
  dataDir: process.env.DATA_DIR || ".",
  refreshIntervalMs: 60 * 60 * 1000,      // poll LiteLLM hourly
  retryTickMs: 5 * 60 * 1000,             // scan retry queue every 5 min
  retryDelayMs: 6 * 60 * 60 * 1000,       // 6h between delivery attempts
  maxRetries: 3,                          // retries after the initial attempt
  verifyTimeoutMs: 10_000,                // registration confirmation ping
  deliveryTimeoutMs: 10_000,              // each change-event POST
  allowPrivateUrls: process.env.ALLOW_PRIVATE_URLS === "true", // SSRF toggle for local testing
};
