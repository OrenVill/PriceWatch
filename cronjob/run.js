import crypto from "crypto";
import nodemailer from "nodemailer";
import { config } from "./config.js";
import {
  getSubscribers,
  saveSubscribers,
  getPrices,
  savePrices,
} from "../lib/s3.js";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const PRICE_CHANGE_THRESHOLD = 0.01;
const WEBHOOK_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

// ─── Pricing fetchers (from legacy monitor.js) ───────────────────────────────

function round(n) {
  return Math.round(n * 10000) / 10000;
}

async function fetchOpenAIPricing() {
  const res = await fetch(LITELLM_URL, {
    headers: { "User-Agent": "PriceWatchBot/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const pricing = {};
  for (const [model, info] of Object.entries(data)) {
    const isOpenAI =
      model.startsWith("gpt-") ||
      model.startsWith("o1") ||
      model.startsWith("o3") ||
      model.startsWith("o4") ||
      model.startsWith("chatgpt");
    if (!isOpenAI) continue;
    if (!info.input_cost_per_token || !info.output_cost_per_token) continue;
    pricing[model] = {
      input: round(info.input_cost_per_token * 1_000_000),
      output: round(info.output_cost_per_token * 1_000_000),
    };
  }
  return pricing;
}

async function fetchAnthropicPricing() {
  const res = await fetch(LITELLM_URL, {
    headers: { "User-Agent": "PriceWatchBot/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const pricing = {};
  for (const [model, info] of Object.entries(data)) {
    if (!model.startsWith("claude")) continue;
    if (!info.input_cost_per_token || !info.output_cost_per_token) continue;
    pricing[model] = {
      input: round(info.input_cost_per_token * 1_000_000),
      output: round(info.output_cost_per_token * 1_000_000),
    };
  }
  return pricing;
}

// ─── Diff ────────────────────────────────────────────────────────────────────

function diffPricing(provider, prev, now) {
  const changes = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(now)]);
  for (const model of allKeys) {
    if (!prev[model] && now[model]) {
      changes.push({ provider, model, type: "NEW_MODEL", prev: null, now: now[model] });
    } else if (prev[model] && !now[model]) {
      changes.push({ provider, model, type: "REMOVED_MODEL", prev: prev[model], now: null });
    } else if (prev[model] && now[model]) {
      const inputPctChange =
        prev[model].input === 0
          ? 0
          : Math.abs(now[model].input - prev[model].input) / prev[model].input;
      const outputPctChange =
        prev[model].output === 0
          ? 0
          : Math.abs(now[model].output - prev[model].output) / prev[model].output;
      const changed =
        prev[model].input !== now[model].input ||
        prev[model].output !== now[model].output;
      const significant =
        inputPctChange >= PRICE_CHANGE_THRESHOLD ||
        outputPctChange >= PRICE_CHANGE_THRESHOLD;
      if (changed && significant) {
        changes.push({
          provider,
          model,
          type: "PRICE_CHANGE",
          prev: prev[model],
          now: now[model],
        });
      }
    }
  }
  return changes;
}

// ─── Webhook push with retry ─────────────────────────────────────────────────

function signPayload(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function postWebhook(subscriber, payloadString) {
  const signature = signPayload(payloadString, subscriber.webhookSecret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(subscriber.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PriceWatch-Signature": signature,
      },
      body: payloadString,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pushWithRetry(subscriber, payloadString, attempt = 0) {
  try {
    await postWebhook(subscriber, payloadString);
    return { ok: true };
  } catch (err) {
    if (attempt >= RETRY_DELAYS_MS.length) {
      return { ok: false, error: err.message };
    }
    console.warn(
      `  ⚠️  Push to ${subscriber.appName} failed (attempt ${attempt + 1}): ${err.message}. Retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`
    );
    await sleep(RETRY_DELAYS_MS[attempt]);
    return pushWithRetry(subscriber, payloadString, attempt + 1);
  }
}

// ─── Email (owner alert + subscriber removal notice) ─────────────────────────

function buildChangeCard(c) {
  if (c.type === "NEW_MODEL") {
    return `
      <div style="background-color:#064e3b;border:1px solid #065f46;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
        <div style="margin-bottom:10px;">
          <span style="background-color:#065f46;color:#6ee7b7;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;display:inline-block;margin-right:6px;">➕ New Model</span>
          <span style="background-color:#1e3a5f;color:#93c5fd;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;display:inline-block;">${c.provider === "openai" ? "OpenAI" : "Anthropic"}</span>
        </div>
        <div style="font-family:monospace;font-size:14px;font-weight:700;color:#ecfdf5;margin-bottom:12px;">${c.model}</div>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="48%" style="background-color:#065f46;border:1px solid #047857;border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:11px;color:#6ee7b7;margin-bottom:3px;">Input</div>
              <div style="font-size:16px;font-weight:800;color:#d1fae5;">$${c.now.input}<span style="font-size:11px;font-weight:400;color:#6ee7b7;">/1M</span></div>
            </td>
            <td width="4%"></td>
            <td width="48%" style="background-color:#065f46;border:1px solid #047857;border-radius:8px;padding:10px;text-align:center;">
              <div style="font-size:11px;color:#6ee7b7;margin-bottom:3px;">Output</div>
              <div style="font-size:16px;font-weight:800;color:#d1fae5;">$${c.now.output}<span style="font-size:11px;font-weight:400;color:#6ee7b7;">/1M</span></div>
            </td>
          </tr>
        </table>
      </div>`;
  }
  if (c.type === "REMOVED_MODEL") {
    return `
      <div style="background-color:#450a0a;border:1px solid #7f1d1d;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
        <div style="margin-bottom:8px;">
          <span style="background-color:#7f1d1d;color:#fca5a5;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;display:inline-block;margin-right:6px;">➖ Removed</span>
          <span style="background-color:#1e3a5f;color:#93c5fd;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;display:inline-block;">${c.provider === "openai" ? "OpenAI" : "Anthropic"}</span>
        </div>
        <div style="font-family:monospace;font-size:14px;font-weight:700;color:#fee2e2;">${c.model}</div>
      </div>`;
  }
  const inputDiff = c.now.input - c.prev.input;
  const outputDiff = c.now.output - c.prev.output;
  const inputUp = inputDiff > 0;
  const outputUp = outputDiff > 0;
  return `
    <div style="background-color:#422006;border:1px solid #78350f;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
      <div style="margin-bottom:10px;">
        <span style="background-color:#78350f;color:#fcd34d;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;display:inline-block;margin-right:6px;">⚠️ Price Change</span>
        <span style="background-color:#1e3a5f;color:#93c5fd;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.5px;display:inline-block;">${c.provider === "openai" ? "OpenAI" : "Anthropic"}</span>
      </div>
      <div style="font-family:monospace;font-size:14px;font-weight:700;color:#fef3c7;margin-bottom:14px;">${c.model}</div>
      <table width="100%" cellpadding="0" cellspacing="6">
        <tr>
          <td style="font-size:12px;color:#d97706;width:55px;">Input</td>
          <td style="font-size:13px;font-weight:600;color:#92400e;text-decoration:line-through;">$${c.prev.input}</td>
          <td style="font-size:13px;color:#d97706;padding:0 6px;">→</td>
          <td style="font-size:15px;font-weight:800;color:${inputUp ? "#fca5a5" : "#6ee7b7"};">$${c.now.input}</td>
          <td><span style="background-color:${inputUp ? "#7f1d1d" : "#064e3b"};color:${inputUp ? "#fca5a5" : "#6ee7b7"};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">${inputUp ? "▲" : "▼"} ${Math.abs(inputDiff).toFixed(4)}</span></td>
        </tr>
        <tr><td colspan="5" style="height:6px;"></td></tr>
        <tr>
          <td style="font-size:12px;color:#d97706;">Output</td>
          <td style="font-size:13px;font-weight:600;color:#92400e;text-decoration:line-through;">$${c.prev.output}</td>
          <td style="font-size:13px;color:#d97706;padding:0 6px;">→</td>
          <td style="font-size:15px;font-weight:800;color:${outputUp ? "#fca5a5" : "#6ee7b7"};">$${c.now.output}</td>
          <td><span style="background-color:${outputUp ? "#7f1d1d" : "#064e3b"};color:${outputUp ? "#fca5a5" : "#6ee7b7"};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;">${outputUp ? "▲" : "▼"} ${Math.abs(outputDiff).toFixed(4)}</span></td>
        </tr>
      </table>
    </div>`;
}

function buildHtmlEmail(changes) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const priceChanges = changes.filter(c => c.type === "PRICE_CHANGE");
  const newModels = changes.filter(c => c.type === "NEW_MODEL");
  const removed = changes.filter(c => c.type === "REMOVED_MODEL");
  const badges = [
    priceChanges.length > 0 ? `<span style="background-color:#78350f;color:#fcd34d;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">⚠️ ${priceChanges.length} price change${priceChanges.length !== 1 ? "s" : ""}</span>` : "",
    newModels.length > 0 ? `<span style="background-color:#065f46;color:#6ee7b7;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">➕ ${newModels.length} new model${newModels.length !== 1 ? "s" : ""}</span>` : "",
    removed.length > 0 ? `<span style="background-color:#7f1d1d;color:#fca5a5;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">➖ ${removed.length} removed</span>` : "",
  ].join("");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"></head>
<body style="margin:0;padding:0;background-color:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
    <tr><td style="background:linear-gradient(135deg,#1e1b4b 0%,#312e81 50%,#4338ca 100%);border-radius:16px 16px 0 0;padding:32px 36px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><div style="color:#a5b4fc;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">PriceWatch</div>
          <div style="color:#fff;font-size:24px;font-weight:800;margin-bottom:4px;">AI Pricing Alert 🚨</div>
          <div style="color:#c7d2fe;font-size:13px;">${dateStr} · ${timeStr}</div></td>
        <td align="right" valign="top"><div style="background-color:rgba(255,255,255,0.15);border-radius:12px;padding:12px 18px;text-align:center;display:inline-block;">
          <div style="color:#fff;font-size:30px;font-weight:900;line-height:1;">${changes.length}</div>
          <div style="color:#c7d2fe;font-size:11px;font-weight:600;">change${changes.length !== 1 ? "s" : ""}</div>
        </div></td>
      </tr></table>
    </td></tr>
    <tr><td style="background-color:#1a1a2e;padding:14px 36px;border-left:1px solid #2d2d4e;border-right:1px solid #2d2d4e;">${badges}</td></tr>
    <tr><td style="background-color:#1a1a2e;padding:24px 36px;border-left:1px solid #2d2d4e;border-right:1px solid #2d2d4e;">${changes.map(buildChangeCard).join("")}</td></tr>
    <tr><td style="background-color:#111827;border:1px solid #1f2937;border-top:none;border-radius:0 0 16px 16px;padding:20px 36px;text-align:center;">
      <p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">
        Pricing data sourced from <a href="https://github.com/BerriAI/litellm" style="color:#818cf8;text-decoration:none;font-weight:600;">LiteLLM community JSON</a><br>
        <strong style="color:#a5b4fc;">PriceWatch</strong> microservice updated automatically.
      </p>
    </td></tr>
  </table>
  </td></tr></table>
</body></html>`;
}

function makeTransport() {
  return nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    auth: { user: config.email.smtp.user, pass: config.email.smtp.pass },
  });
}

async function sendOwnerAlert(changes) {
  if (!config.email.smtp.user) return;
  const transporter = makeTransport();
  await transporter.sendMail({
    from: config.email.from,
    to: config.email.to,
    subject: `🚨 PriceWatch: ${changes.length} AI Pricing Change${changes.length !== 1 ? "s" : ""} Detected`,
    html: buildHtmlEmail(changes),
  });
  console.log(`📬 Owner alert sent — ${changes.length} change(s)`);
}

async function sendSubscriberRemovedEmail(subscriber) {
  if (!config.email.smtp.user) return;
  const transporter = makeTransport();
  await transporter.sendMail({
    from: config.email.from,
    to: subscriber.contactEmail,
    subject: `PriceWatch: subscription removed after repeated delivery failures`,
    text: `Hi ${subscriber.appName},\n\nWe were unable to deliver price updates to ${subscriber.webhookUrl} after 3 consecutive attempts. Your subscription has been removed.\n\nTo resubscribe, please re-register once your endpoint is reachable.\n\n— PriceWatch`,
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] PriceWatch cronjob starting`);

  const [openai, anthropic] = await Promise.all([
    fetchOpenAIPricing(),
    fetchAnthropicPricing(),
  ]);
  const currentPrices = {
    openai,
    anthropic,
    lastUpdated: new Date().toISOString(),
  };

  const previous = await getPrices();
  if (!previous) {
    console.log("No previous prices.json — saving initial snapshot and exiting.");
    await savePrices(currentPrices);
    return;
  }

  const changes = [
    ...diffPricing("openai", previous.openai || {}, openai),
    ...diffPricing("anthropic", previous.anthropic || {}, anthropic),
  ];

  if (changes.length === 0) {
    console.log("No changes detected. Updating timestamp and exiting.");
    await savePrices(currentPrices);
    return;
  }

  console.log(`${changes.length} change(s) detected.`);
  await savePrices(currentPrices);

  const subscribers = await getSubscribers();
  if (subscribers.length === 0) {
    console.log("No subscribers to notify.");
    await sendOwnerAlert(changes).catch(err => console.error("Owner alert failed:", err.message));
    return;
  }

  const payload = {
    event: "price.update",
    timestamp: currentPrices.lastUpdated,
    changes,
    prices: { openai, anthropic },
  };
  const payloadString = JSON.stringify(payload);

  const results = await Promise.all(
    subscribers.map(async sub => {
      const result = await pushWithRetry(sub, payloadString);
      return { sub, result };
    })
  );

  const survivors = [];
  for (const { sub, result } of results) {
    if (result.ok) {
      survivors.push({ ...sub, lastPushAt: currentPrices.lastUpdated, failureCount: 0 });
      console.log(`  ✅ Pushed to ${sub.appName}`);
    } else {
      console.error(`  ❌ Removing ${sub.appName} (${sub.webhookUrl}): ${result.error}`);
      await sendSubscriberRemovedEmail(sub).catch(err =>
        console.error(`  Email to ${sub.contactEmail} failed:`, err.message)
      );
    }
  }

  await saveSubscribers(survivors);
  await sendOwnerAlert(changes).catch(err => console.error("Owner alert failed:", err.message));

  console.log("Done.");
}

main().catch(err => {
  console.error("Cronjob failed:", err);
  process.exit(1);
});
