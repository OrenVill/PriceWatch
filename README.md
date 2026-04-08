# Nexvill Pricing Monitor

Scrapes OpenAI and Anthropic pricing pages daily, diffs against a stored baseline, and emails you when anything changes.

## Setup

```bash
npm install
```

## Configure

Edit `config.js`:
- Set `email.enabled = true`
- Fill in your SMTP credentials (Gmail, SendGrid, etc.)
- Set `email.to` to your address

## Run manually

```bash
node monitor.js
```

## Schedule (cron) — run daily at 9am

```bash
crontab -e
# Add this line:
0 9 * * * cd /path/to/nexvill-pricing-monitor && node monitor.js >> /var/log/nexvill-pricing.log 2>&1
```

## How it works

1. Fetches `openai.com/api/pricing` and `anthropic.com/pricing`
2. Parses model names and input/output token prices
3. Compares against `pricing-baseline.json`
4. If changes detected → sends alert email + updates baseline
5. Exits with code `1` if changes were found (useful for CI/CD pipelines)

## Files

| File | Purpose |
|---|---|
| `monitor.js` | Main scraper + diff + alert logic |
| `config.js` | Email/SMTP settings |
| `pricing-baseline.json` | Stored known-good pricing (auto-updated) |

## ⚠️ Scraper fragility

Both OpenAI and Anthropic can change their page layout at any time, which may break parsing. If you get "0 models found" warnings, the scraper needs updating. The `pricing-baseline.json` will **not** be overwritten with empty data in that case — only real changes update it.

## Gmail App Password

If using Gmail SMTP, generate an App Password at:  
`myaccount.google.com → Security → 2-Step Verification → App Passwords`
