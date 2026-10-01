/**
 * Catalog-only HTTP surface: read-only pricing, no webhooks or subscribers.
 * Uses node:http only (no Express) to keep memory and CPU low in-cluster.
 */
import http from "node:http";
import { fetchPricing, buildPricesPayload } from "./pricing.js";

const HEALTHZ_BODY = Buffer.from('{"ok":true,"mode":"catalog"}');
const NOT_FOUND_BODY = Buffer.from('{"error":"not found"}');

export function createCatalogCache() {
  const cache = {
    openai: {},
    anthropic: {},
    gemini: {},
    lastUpdated: null,
    pricesJson: Buffer.from(
      JSON.stringify({
        openai: {},
        anthropic: {},
        gemini: {},
        lastUpdated: null,
      }),
    ),
  };
  return cache;
}

export function syncPricesJson(cache) {
  cache.pricesJson = Buffer.from(
    JSON.stringify(
      buildPricesPayload({
        openai: cache.openai,
        anthropic: cache.anthropic,
        gemini: cache.gemini,
        lastUpdated: cache.lastUpdated,
      }),
    ),
  );
}

export function getPricesResponse(cache) {
  return buildPricesPayload({
    openai: cache.openai,
    anthropic: cache.anthropic,
    gemini: cache.gemini,
    lastUpdated: cache.lastUpdated,
  });
}

export async function refreshCatalog(cache, fetchOptions) {
  try {
    const { openai, anthropic, gemini } = await fetchPricing(fetchOptions);
    const lastUpdated = new Date().toISOString();
    cache.openai = openai;
    cache.anthropic = anthropic;
    cache.gemini = gemini;
    cache.lastUpdated = lastUpdated;
    syncPricesJson(cache);
    console.log(
      `[catalog] refreshed openai=${Object.keys(openai).length} anthropic=${Object.keys(anthropic).length} gemini=${Object.keys(gemini).length} lastUpdated=${lastUpdated}`,
    );
    return true;
  } catch (err) {
    console.error(`[catalog] refresh failed: ${err.message}`);
    return false;
  }
}

export function createCatalogRequestListener(cache) {
  return (req, res) => {
    const path = req.url?.split("?")[0] ?? "";

    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": HEALTHZ_BODY.length,
      });
      res.end(HEALTHZ_BODY);
      return;
    }

    if (req.method === "GET" && path === "/prices") {
      const body = cache.pricesJson;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      });
      res.end(body);
      return;
    }

    if (
      (req.method === "POST" && path === "/subscribe") ||
      (req.method === "DELETE" && path.startsWith("/subscribe/"))
    ) {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Content-Length": NOT_FOUND_BODY.length,
      });
      res.end(NOT_FOUND_BODY);
      return;
    }

    res.writeHead(404).end();
  };
}

/** @deprecated Use createCatalogRequestListener + http.createServer in tests. */
export function createCatalogApp(cache) {
  return http.createServer(createCatalogRequestListener(cache));
}

export async function startCatalogServer(config) {
  const cache = createCatalogCache();
  const fetchOptions = {
    timeoutMs: config.httpTimeoutMs,
    userAgent: config.userAgent,
  };

  await refreshCatalog(cache, fetchOptions);

  if (config.refreshIntervalSec > 0) {
    const timer = setInterval(
      () => refreshCatalog(cache, fetchOptions),
      config.refreshIntervalMs,
    );
    timer.unref();
  }

  const server = http.createServer(createCatalogRequestListener(cache));
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 6000;

  await new Promise((resolve) => {
    server.listen(config.port, () => {
      console.log(
        `[catalog] mode=${config.mode} listening on http://0.0.0.0:${config.port} refreshIntervalSec=${config.refreshIntervalSec}`,
      );
      console.log("   GET /prices");
      console.log("   GET /healthz");
      resolve();
    });
  });

  return server;
}
