/**
 * PriceWatch v2 — event-driven webhook push.
 * Clients register a webhook URL; the server POSTs signed pricing-change events
 * and retries failures. Internally it polls LiteLLM hourly and diffs a baseline.
 *
 * Run: node server.js
 */
import express from "express";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { fetchPricing, diffPricing } from "./pricing.js";
import { createStore } from "./store.js";
import { postEvent, sendVerification, nextRetry } from "./delivery.js";
import { isAllowedUrl } from "./url-guard.js";

const store = createStore(config.dataDir);
const BASELINE = "pricing-baseline.json";
const VALID_PROVIDERS = ["openai", "anthropic", "gemini"];

let lastUpdated = null;
let nextUpdate = null;

// ── Detection + fan-out ────────────────────────────────────────────────────
const fetchOptions = {
  timeoutMs: config.httpTimeoutMs,
  userAgent: config.userAgent,
};

async function detectAndPush() {
  let current;
  try {
    current = await fetchPricing(fetchOptions);
  } catch (err) {
    console.error(`[detect] fetch failed: ${err.message}`);
    return;
  }

  const baseline = await store.readJson(BASELINE, null);

  // First-boot seeding: populate the baseline silently, notify on later diffs only.
  if (!baseline || (!baseline.openai && !baseline.anthropic && !baseline.gemini)) {
    await store.writeJson(BASELINE, { ...current, lastUpdated: new Date().toISOString() });
    lastUpdated = new Date().toISOString();
    nextUpdate = new Date(Date.now() + config.refreshIntervalMs).toISOString();
    console.log("[detect] baseline seeded (no notifications on first run).");
    return;
  }

  const changes = [
    ...diffPricing("openai", baseline.openai || {}, current.openai),
    ...diffPricing("anthropic", baseline.anthropic || {}, current.anthropic),
    ...diffPricing("gemini", baseline.gemini || {}, current.gemini),
  ];

  if (changes.length > 0) {
    const subs = (await store.listSubscribers()).filter((s) => s.status === "active");
    for (const sub of subs) {
      const relevant = changes.filter((c) => sub.providers.includes(c.provider));
      if (relevant.length === 0) continue;
      // Isolate each subscriber: a delivery or enqueue error must not abort the
      // rest of the fan-out or skip the baseline write below.
      try {
        const payload = {
          type: "change",
          deliveryId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          changes: relevant,
        };
        const res = await postEvent({
          url: sub.url, event: "change", payload, secret: sub.secret,
          timeoutMs: config.deliveryTimeoutMs,
        });
        if (!res.ok) {
          await store.enqueueRetry({
            subscriberId: sub.id, url: sub.url, payload,
            attempts: 1, lastError: res.error || `HTTP ${res.status}`,
            nextAttempt: new Date(Date.now() + config.retryDelayMs).toISOString(),
          });
          console.warn(`[detect] delivery to ${sub.id} failed, queued for retry.`);
        }
      } catch (err) {
        console.error(`[detect] error handling subscriber ${sub.id}: ${err.message}`);
      }
    }
    console.log(`[detect] ${changes.length} change(s) fanned out to ${subs.length} subscriber(s).`);
  } else {
    console.log("[detect] no changes.");
  }

  await store.writeJson(BASELINE, { ...current, lastUpdated: new Date().toISOString() });
  lastUpdated = new Date().toISOString();
  nextUpdate = new Date(Date.now() + config.refreshIntervalMs).toISOString();
}

// ── Retry tick ─────────────────────────────────────────────────────────────
async function processRetries() {
  const due = await store.dueRetries(new Date());
  for (const item of due) {
    const sub = await store.getSubscriber(item.subscriberId);
    if (!sub) { await store.dropRetry(item.deliveryId); continue; }
    const res = await postEvent({
      url: item.url, event: "change", payload: item.payload, secret: sub.secret,
      timeoutMs: config.deliveryTimeoutMs,
    });
    if (res.ok) {
      await store.dropRetry(item.deliveryId);
      continue;
    }
    const decision = nextRetry(item, {
      maxRetries: config.maxRetries, retryDelayMs: config.retryDelayMs, now: new Date(),
    });
    if (decision.drop) {
      await store.dropRetry(item.deliveryId);
      console.warn(`[retry] giving up on delivery ${item.deliveryId}.`);
    } else {
      await store.updateRetry(item.deliveryId, {
        attempts: decision.attempts, nextAttempt: decision.nextAttempt,
        lastError: res.error || `HTTP ${res.status}`,
      });
    }
  }
}

// ── HTTP app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.post("/subscribe", async (req, res) => {
  const { url, providers } = req.body ?? {};
  if (typeof url !== "string" || !isAllowedUrl(url, config.allowPrivateUrls)) {
    return res.status(400).json({ error: "Invalid or disallowed url." });
  }
  if (!Array.isArray(providers) || providers.length === 0 ||
      !providers.every((p) => VALID_PROVIDERS.includes(p))) {
    return res.status(400).json({ error: `providers must be a non-empty subset of ${VALID_PROVIDERS.join(", ")}.` });
  }

  const secret = crypto.randomBytes(32).toString("hex");
  const challenge = crypto.randomBytes(16).toString("hex");
  const sub = await store.addSubscriber({ url, providers, secret, challenge });

  const verified = await sendVerification({
    url, id: sub.id, challenge, secret, timeoutMs: config.verifyTimeoutMs,
  });
  if (!verified) {
    await store.removeSubscriber(sub.id);
    return res.status(400).json({ error: "verification failed" });
  }

  await store.updateSubscriber(sub.id, { status: "active", challenge: null, verifiedAt: new Date().toISOString() });
  res.status(201).json({ id: sub.id, status: "active", providers });
});

app.delete("/subscribe/:id", async (req, res) => {
  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const sub = await store.getSubscriber(req.params.id);
  if (!sub || !token || token !== sub.secret) {
    return res.status(404).json({ error: "not found" });
  }
  await store.removeSubscriber(sub.id);
  res.status(204).end();
});

app.get("/health", async (req, res) => {
  const subs = await store.listSubscribers();
  const baseline = await store.readJson(BASELINE, { openai: {}, anthropic: {}, gemini: {} });
  res.json({
    status: "ok",
    lastUpdated, nextUpdate,
    models: {
      openai: Object.keys(baseline.openai || {}).length,
      anthropic: Object.keys(baseline.anthropic || {}).length,
      gemini: Object.keys(baseline.gemini || {}).length,
    },
    subscribers: {
      active: subs.filter((s) => s.status === "active").length,
      pending: subs.filter((s) => s.status === "pending").length,
    },
    retries: { pending: (await store.listRetries()).length },
  });
});

// ── Boot ───────────────────────────────────────────────────────────────────
export { app, detectAndPush, processRetries, store };

export async function start() {
  if (config.isCatalog) {
    const { startCatalogServer } = await import("./catalog.js");
    await startCatalogServer(config);
    return;
  }
  await detectAndPush();
  setInterval(detectAndPush, config.refreshIntervalMs);
  setInterval(processRetries, config.retryTickMs);
  app.listen(config.port, () => {
    console.log(`\n🚀 PriceWatch v2 on http://localhost:${config.port}`);
    console.log(`   POST   /subscribe       { url, providers }`);
    console.log(`   DELETE /subscribe/:id   (Authorization: Bearer <secret>)`);
    console.log(`   GET    /health\n`);
  });
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === fileURLToPath(process.argv[1]);

if (isMain) {
  await start();
}
