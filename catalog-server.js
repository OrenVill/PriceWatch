/**
 * Minimal catalog entrypoint — does not load webhook/subscriber modules or npm deps.
 * Used by the catalog container image and recommended for in-cluster sidecars.
 */
import { buildConfig } from "./env-config.js";
import { startCatalogServer } from "./catalog.js";

if (!process.env.PRICEWATCH_MODE) {
  process.env.PRICEWATCH_MODE = "catalog";
}

const config = buildConfig();
await startCatalogServer(config);
