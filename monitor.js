/**
 * Nexvill AI Pricing Monitor
 * Fetches OpenAI and Anthropic pricing from reliable sources, diffs against
 * baseline, and sends a styled HTML email alert via Gmail if anything has changed.
 *
 * Run manually:        node monitor.js
 * Run as cron (daily): 0 9 * * * /usr/bin/node /path/to/monitor.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(__dirname, "pricing-baseline.json");

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchOpenAIPricing() {
  const res = await fetch(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    { headers: { "User-Agent": "NexvillPricingBot/1.0" } }
  );
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

  if (Object.keys(pricing).length === 0) throw new Error("No OpenAI models parsed from JSON.");
  return { pricing, source: "LiteLLM community JSON" };
}

async function fetchAnthropicPricing() {
  const res = await fetch(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    { headers: { "User-Agent": "NexvillPricingBot/1.0" } }
  );
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

  if (Object.keys(pricing).length === 0) throw new Error("No Anthropic models parsed from JSON.");
  return { pricing, source: "LiteLLM community JSON" };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round(n) {
  return Math.round(n * 10000) / 10000;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

function diffPricing(provider, baseline, current) {
  const changes = [];
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const model of allKeys) {
    const prev = baseline[model];
    const now = current[model];

    if (!prev && now) {
      changes.push({ provider, model, type: "NEW_MODEL", prev: null, now });
    } else if (prev && !now) {
      changes.push({ provider, model, type: "REMOVED_MODEL", prev, now: null });
    } else if (prev && now) {
      if (prev.input !== now.input || prev.output !== now.output) {
        changes.push({ provider, model, type: "PRICE_CHANGE", prev, now });
      }
    }
  }

  return changes;
}

// ─── Baseline I/O ─────────────────────────────────────────────────────────────

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return { openai: {}, anthropic: {} };
  return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
}

function saveBaseline(data) {
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(data, null, 2));
  console.log("✅ Baseline updated.");
}

// ─── HTML Email ───────────────────────────────────────────────────────────────

function buildChangeCard(c) {
  if (c.type === "NEW_MODEL") {
    return `
      <!--[if !mso]><!-->
      <div style="background-color:#064e3b;border:1px solid #065f46;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
      <!--<![endif]-->
      <!--[if mso]>
      <div style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-bottom:12px;">
      <![endif]-->
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

  // PRICE_CHANGE
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
          <td style="font-size:12px;color:#d97706;width:55px;padding-right:6px;">Input</td>
          <td style="font-size:13px;font-weight:600;color:#92400e;text-decoration:line-through;width:50px;">$${c.prev.input}</td>
          <td style="font-size:13px;color:#d97706;padding:0 6px;width:20px;">→</td>
          <td style="font-size:15px;font-weight:800;color:${inputUp ? "#fca5a5" : "#6ee7b7"};">$${c.now.input}</td>
          <td style="padding-left:8px;">
            <span style="background-color:${inputUp ? "#7f1d1d" : "#064e3b"};color:${inputUp ? "#fca5a5" : "#6ee7b7"};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap;">${inputUp ? "▲" : "▼"} ${Math.abs(inputDiff).toFixed(4)}</span>
          </td>
        </tr>
        <tr><td colspan="5" style="height:6px;"></td></tr>
        <tr>
          <td style="font-size:12px;color:#d97706;padding-right:6px;">Output</td>
          <td style="font-size:13px;font-weight:600;color:#92400e;text-decoration:line-through;">$${c.prev.output}</td>
          <td style="font-size:13px;color:#d97706;padding:0 6px;">→</td>
          <td style="font-size:15px;font-weight:800;color:${outputUp ? "#fca5a5" : "#6ee7b7"};">$${c.now.output}</td>
          <td style="padding-left:8px;">
            <span style="background-color:${outputUp ? "#7f1d1d" : "#064e3b"};color:${outputUp ? "#fca5a5" : "#6ee7b7"};font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;white-space:nowrap;">${outputUp ? "▲" : "▼"} ${Math.abs(outputDiff).toFixed(4)}</span>
          </td>
        </tr>
      </table>
    </div>`;
}

function buildHtmlEmail(changes) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

  const priceChanges = changes.filter(c => c.type === "PRICE_CHANGE");
  const newModels    = changes.filter(c => c.type === "NEW_MODEL");
  const removed      = changes.filter(c => c.type === "REMOVED_MODEL");

  const summaryBadges = [
    priceChanges.length > 0 ? `<span style="background-color:#78350f;color:#fcd34d;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">⚠️ ${priceChanges.length} price change${priceChanges.length !== 1 ? "s" : ""}</span>` : "",
    newModels.length > 0    ? `<span style="background-color:#065f46;color:#6ee7b7;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">➕ ${newModels.length} new model${newModels.length !== 1 ? "s" : ""}</span>` : "",
    removed.length > 0      ? `<span style="background-color:#7f1d1d;color:#fca5a5;font-size:12px;font-weight:700;padding:5px 13px;border-radius:20px;display:inline-block;margin-right:6px;margin-bottom:6px;">➖ ${removed.length} removed</span>` : "",
  ].join("");

  const cards = changes.map(buildChangeCard).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>
    :root { color-scheme: light dark; }

    @media (prefers-color-scheme: dark) {
      .email-body { background-color: #0f0f0f !important; }
      .email-card { background-color: #1a1a2e !important; }
      .summary-bar { background-color: #1a1a2e !important; border-color: #2d2d4e !important; }
      .footer-cell { background-color: #111827 !important; border-color: #1f2937 !important; }
      .footer-text { color: #6b7280 !important; }
      .footer-link { color: #818cf8 !important; }
      .header-sub { color: #a5b4fc !important; }
      .header-date { color: #c7d2fe !important; }
      .change-count-box { background-color: rgba(255,255,255,0.12) !important; }
    }

    @media (prefers-color-scheme: light) {
      .email-body { background-color: #f3f4f6 !important; }
      .email-card { background-color: #ffffff !important; }
      .summary-bar { background-color: #ffffff !important; border-color: #f3f4f6 !important; }
      .footer-cell { background-color: #f9fafb !important; border-color: #e5e7eb !important; }
      .footer-text { color: #9ca3af !important; }
      .footer-link { color: #6366f1 !important; }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e1b4b 0%,#312e81 50%,#4338ca 100%);border-radius:16px 16px 0 0;padding:32px 36px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div class="header-sub" style="color:#a5b4fc;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Nexvill Monitor</div>
                  <div style="color:#ffffff;font-size:24px;font-weight:800;margin-bottom:4px;line-height:1.2;">AI Pricing Alert 🚨</div>
                  <div class="header-date" style="color:#c7d2fe;font-size:13px;">${dateStr} &middot; ${timeStr}</div>
                </td>
                <td align="right" valign="top">
                  <div class="change-count-box" style="background-color:rgba(255,255,255,0.15);border-radius:12px;padding:12px 18px;text-align:center;display:inline-block;">
                    <div style="color:#ffffff;font-size:30px;font-weight:900;line-height:1;">${changes.length}</div>
                    <div style="color:#c7d2fe;font-size:11px;font-weight:600;">change${changes.length !== 1 ? "s" : ""}</div>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Summary bar -->
        <tr>
          <td class="summary-bar" style="background-color:#1a1a2e;padding:14px 36px;border-left:1px solid #2d2d4e;border-right:1px solid #2d2d4e;">
            ${summaryBadges}
          </td>
        </tr>

        <!-- Cards -->
        <tr>
          <td class="email-card" style="background-color:#1a1a2e;padding:24px 36px;border-left:1px solid #2d2d4e;border-right:1px solid #2d2d4e;">
            ${cards}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="footer-cell" style="background-color:#111827;border:1px solid #1f2937;border-top:none;border-radius:0 0 16px 16px;padding:20px 36px;text-align:center;">
            <p class="footer-text" style="font-size:12px;color:#6b7280;line-height:1.6;margin:0;">
              Pricing data sourced from
              <a href="https://github.com/BerriAI/litellm" class="footer-link" style="color:#818cf8;text-decoration:none;font-weight:600;">LiteLLM community JSON</a><br>
              Update your <strong style="color:#a5b4fc;">Nexvill</strong> billing config to reflect these changes.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Alerting ─────────────────────────────────────────────────────────────────

async function sendAlert(changes) {
  console.log("\n📬 Sending alert email...\n");

  if (!config.email.enabled) {
    console.log("⚠️  Email alerts disabled in config.js.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.secure,
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass,
    },
  });

  await transporter.sendMail({
    from: config.email.from,
    to: config.email.to,
    subject: `🚨 Nexvill: ${changes.length} AI Pricing Change${changes.length !== 1 ? "s" : ""} Detected`,
    html: buildHtmlEmail(changes),
  });

  console.log("✅ Alert email sent to", config.email.to);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Nexvill Pricing Monitor starting...\n");

  const baseline = loadBaseline();
  const allChanges = [];

  let currentOpenAI = null;
  let currentAnthropic = null;

  try {
    console.log("Fetching OpenAI pricing...");
    const { pricing, source } = await fetchOpenAIPricing();
    currentOpenAI = pricing;
    console.log(`  ✅ Found ${Object.keys(pricing).length} OpenAI model(s) via ${source}.`);
  } catch (err) {
    console.error("  ❌ OpenAI fetch failed:", err.message);
    console.error("  ⏭  Skipping OpenAI diff to avoid false removals.");
  }

  try {
    console.log("Fetching Anthropic pricing...");
    const { pricing, source } = await fetchAnthropicPricing();
    currentAnthropic = pricing;
    console.log(`  ✅ Found ${Object.keys(pricing).length} Anthropic model(s) via ${source}.`);
  } catch (err) {
    console.error("  ❌ Anthropic fetch failed:", err.message);
    console.error("  ⏭  Skipping Anthropic diff to avoid false removals.");
  }

  if (currentOpenAI !== null) {
    allChanges.push(...diffPricing("openai", baseline.openai || {}, currentOpenAI));
  }
  if (currentAnthropic !== null) {
    allChanges.push(...diffPricing("anthropic", baseline.anthropic || {}, currentAnthropic));
  }

  if (allChanges.length > 0) {
    console.log(`\n🔔 ${allChanges.length} change(s) detected.`);
    await sendAlert(allChanges);
  } else {
    console.log("\n✅ No pricing changes detected.");
  }

  saveBaseline({
    openai: currentOpenAI !== null ? currentOpenAI : (baseline.openai || {}),
    anthropic: currentAnthropic !== null ? currentAnthropic : (baseline.anthropic || {}),
    lastChecked: new Date().toISOString(),
  });

  console.log("\nDone.");
  process.exit(allChanges.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});