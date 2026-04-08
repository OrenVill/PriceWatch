/**
 * PriceWatch — AI Pricing Microservice
 * Serves cached OpenAI + Anthropic pricing via a REST API.
 * Refreshes from LiteLLM every hour and sends email alerts on changes.
 *
 * Run: node server.js
 */

import express from "express";
import nodemailer from "nodemailer";
import { config } from "./config.js";

const app = express();

// ─── In-memory cache ──────────────────────────────────────────────────────────

let cache = {
  openai: {},
  anthropic: {},
  lastUpdated: null,
  nextUpdate: null,
};

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchAllPricing() {
  const res = await fetch(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    { headers: { "User-Agent": "PriceWatchBot/1.0" } }
  );
  if (!res.ok) throw new Error(`LiteLLM fetch failed: HTTP ${res.status}`);
  const data = await res.json();

  const openai = {};
  const anthropic = {};

  for (const [model, info] of Object.entries(data)) {
    if (!info.input_cost_per_token || !info.output_cost_per_token) continue;

    const entry = {
      input:  round(info.input_cost_per_token  * 1_000_000),
      output: round(info.output_cost_per_token * 1_000_000),
    };

    const isOpenAI =
      model.startsWith("gpt-") ||
      model.startsWith("o1")   ||
      model.startsWith("o3")   ||
      model.startsWith("o4")   ||
      model.startsWith("chatgpt");

    if (isOpenAI)                  openai[model]    = entry;
    else if (model.startsWith("claude")) anthropic[model] = entry;
  }

  return { openai, anthropic };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round(n) {
  return Math.round(n * 10000) / 10000;
}

function diffPricing(provider, prev, now) {
  const changes = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(now)]);
  for (const model of allKeys) {
    if (!prev[model] && now[model])
      changes.push({ provider, model, type: "NEW_MODEL", prev: null, now: now[model] });
    else if (prev[model] && !now[model])
      changes.push({ provider, model, type: "REMOVED_MODEL", prev: prev[model], now: null });
    else if (prev[model] && now[model] &&
      (prev[model].input !== now[model].input || prev[model].output !== now[model].output))
      changes.push({ provider, model, type: "PRICE_CHANGE", prev: prev[model], now: now[model] });
  }
  return changes;
}

// ─── Email alert ──────────────────────────────────────────────────────────────

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
  const inputDiff  = c.now.input  - c.prev.input;
  const outputDiff = c.now.output - c.prev.output;
  const inputUp    = inputDiff  > 0;
  const outputUp   = outputDiff > 0;
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
  const now        = new Date();
  const dateStr    = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr    = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const priceChanges = changes.filter(c => c.type === "PRICE_CHANGE");
  const newModels    = changes.filter(c => c.type === "NEW_MODEL");
  const removed      = changes.filter(c => c.type === "REMOVED_MODEL");
  const badges = [
    priceChanges.length > 0 ? `<span style="background-color:#78350f;color:#fcd34d;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">⚠️ ${priceChanges.length} price change${priceChanges.length !== 1 ? "s" : ""}</span>` : "",
    newModels.length    > 0 ? `<span style="background-color:#065f46;color:#6ee7b7;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">➕ ${newModels.length} new model${newModels.length !== 1 ? "s" : ""}</span>` : "",
    removed.length      > 0 ? `<span style="background-color:#7f1d1d;color:#fca5a5;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">➖ ${removed.length} removed</span>` : "",
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
        <strong style="color:#a5b4fc;">PriceWatch</strong> microservice updated its cache automatically.
      </p>
    </td></tr>
  </table>
  </td></tr></table>
</body></html>`;
}

async function sendAlert(changes) {
  if (!config.email.enabled) return;
  const transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    auth: { user: config.email.smtp.user, pass: config.email.smtp.pass },
  });
  await transporter.sendMail({
    from: config.email.from,
    to: config.email.to,
    subject: `🚨 PriceWatch: ${changes.length} AI Pricing Change${changes.length !== 1 ? "s" : ""} Detected`,
    html: buildHtmlEmail(changes),
  });
  console.log(`📬 Alert sent — ${changes.length} change(s)`);
}

// ─── Cache refresh ────────────────────────────────────────────────────────────

async function refreshCache() {
  console.log(`[${new Date().toISOString()}] Refreshing pricing cache...`);
  try {
    const { openai, anthropic } = await fetchAllPricing();

    // Diff against current cache and alert if changed
    const changes = [
      ...diffPricing("openai",    cache.openai,    openai),
      ...diffPricing("anthropic", cache.anthropic, anthropic),
    ];

    if (changes.length > 0) {
      console.log(`  ⚠️  ${changes.length} change(s) detected — sending alert.`);
      await sendAlert(changes).catch(err => console.error("  Email error:", err.message));
    } else {
      console.log("  ✅ No changes.");
    }

    cache = {
      openai,
      anthropic,
      lastUpdated: new Date().toISOString(),
      nextUpdate:  new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  } catch (err) {
    console.error("  ❌ Cache refresh failed:", err.message);
  }
}


// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — no auth required
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    lastUpdated: cache.lastUpdated,
    nextUpdate:  cache.nextUpdate,
    models: {
      openai:    Object.keys(cache.openai).length,
      anthropic: Object.keys(cache.anthropic).length,
    },
  });
});

// All models
app.get("/prices", (req, res) => {
  res.json({
    lastUpdated: cache.lastUpdated,
    nextUpdate:  cache.nextUpdate,
    openai:      cache.openai,
    anthropic:   cache.anthropic,
  });
});

// OpenAI only
app.get("/prices/openai", (req, res) => {
  res.json({ lastUpdated: cache.lastUpdated, models: cache.openai });
});

// Anthropic only
app.get("/prices/anthropic", (req, res) => {
  res.json({ lastUpdated: cache.lastUpdated, models: cache.anthropic });
});

// Single model lookup — e.g. GET /prices/model/gpt-4o
app.get("/prices/model/:model", (req, res) => {
  const name = req.params.model.toLowerCase();
  const result = cache.openai[name] || cache.anthropic[name];
  if (!result) {
    return res.status(404).json({ error: `Model "${name}" not found.` });
  }
  const provider = cache.openai[name] ? "openai" : "anthropic";
  res.json({ model: name, provider, ...result, lastUpdated: cache.lastUpdated });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

// Load cache immediately on start, then refresh every hour
await refreshCache();
setInterval(refreshCache, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🚀 PriceWatch running on http://localhost:${PORT}`);
  console.log(`   GET /health`);
  console.log(`   GET /prices`);
  console.log(`   GET /prices/openai`);
  console.log(`   GET /prices/anthropic`);
  console.log(`   GET /prices/model/:model\n`);
});
