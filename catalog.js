/**
 * Catalog-only HTTP surface: read-only pricing, no webhooks or subscribers.
 * Uses node:http only (no Express) to keep memory and CPU low in-cluster.
 */
import http from "node:http";
import {
  fetchPricing,
  buildPricesPayload,
  modelCounts,
} from "./pricing.js";

const NOT_FOUND_BODY = Buffer.from('{"error":"not found"}');

export function buildHealthzBody(providers) {
  return Buffer.from(
    JSON.stringify({ ok: true, mode: "catalog", providers }),
  );
}

export function createCatalogCache(providers) {
  const pricing = Object.fromEntries(providers.map((p) => [p, {}]));
  const cache = {
    providers,
    pricing,
    lastUpdated: null,
    pricesJson: Buffer.from(JSON.stringify(buildPricesPayload(pricing, null))),
    healthzBody: buildHealthzBody(providers),
  };
  return cache;
}

export function syncPricesJson(cache) {
  cache.pricesJson = Buffer.from(
    JSON.stringify(buildPricesPayload(cache.pricing, cache.lastUpdated)),
  );
}

export function getPricesResponse(cache) {
  return buildPricesPayload(cache.pricing, cache.lastUpdated);
}

export async function refreshCatalog(cache, fetchOptions) {
  try {
    const pricing = await fetchPricing({
      ...fetchOptions,
      providers: cache.providers,
    });
    const lastUpdated = new Date().toISOString();
    cache.pricing = pricing;
    cache.lastUpdated = lastUpdated;
    syncPricesJson(cache);
    const counts = modelCounts(pricing, cache.providers);
    const summary = cache.providers
      .map((p) => `${p}=${counts[p]}`)
      .join(" ");
    console.log(`[catalog] refreshed ${summary} lastUpdated=${lastUpdated}`);
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
      const body = cache.healthzBody;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      });
      res.end(body);
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
  const cache = createCatalogCache(config.catalogProviders);
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
        `[catalog] mode=${config.mode} providers=${config.catalogProviders.join(",")} listening on http://0.0.0.0:${config.port} refreshIntervalSec=${config.refreshIntervalSec}`,
      );
      console.log("   GET /prices");
      console.log("   GET /healthz");
      resolve();
    });
  });

  return server;
}
