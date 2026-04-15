import express from "express";
import { config } from "./config.js";
import { getSubscribers, saveSubscribers } from "../lib/s3.js";

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.header("X-Api-Key") !== config.apiKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/health", async (req, res) => {
  try {
    const subs = await getSubscribers();
    res.json({
      status: "ok",
      registeredSubscribers: subs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: "error", error: err.message });
  }
});

app.post("/subscribe", requireApiKey, async (req, res) => {
  const { appName, webhookUrl, webhookSecret, contactEmail } = req.body || {};
  if (!appName || !webhookUrl || !webhookSecret || !contactEmail) {
    return res.status(400).json({
      error: "Missing required fields: appName, webhookUrl, webhookSecret, contactEmail",
    });
  }

  const subscribers = await getSubscribers();
  if (subscribers.some(s => s.webhookUrl === webhookUrl)) {
    return res.status(409).json({ error: "webhookUrl already registered" });
  }

  subscribers.push({
    appName,
    webhookUrl,
    webhookSecret,
    contactEmail,
    registeredAt: new Date().toISOString(),
    lastPushAt: null,
    failureCount: 0,
  });
  await saveSubscribers(subscribers);

  res.status(201).json({
    message: "Registered successfully. You will receive prices on the next PriceWatch run.",
  });
});

app.delete("/unsubscribe", requireApiKey, async (req, res) => {
  const { webhookUrl } = req.body || {};
  if (!webhookUrl) return res.status(400).json({ error: "Missing webhookUrl" });

  const subscribers = await getSubscribers();
  const filtered = subscribers.filter(s => s.webhookUrl !== webhookUrl);
  await saveSubscribers(filtered);

  res.json({ message: "Unsubscribed successfully." });
});

app.listen(config.port, () => {
  console.log(`PriceWatch registration service listening on :${config.port}`);
});
