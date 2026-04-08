# PriceWatch — AI Pricing Monitor

Automatically monitors OpenAI and Anthropic model pricing, detects changes, and sends you a beautiful email alert the moment anything shifts.

---

## How it works

1. Fetches live pricing from the [LiteLLM community JSON](https://github.com/BerriAI/litellm) (updated by the community on every price change)
2. Compares against your stored `pricing-baseline.json`
3. If anything changed → sends you a styled HTML email with a full breakdown
4. Updates the baseline so you only get alerted once per change

---

## Setup

### 1. Install dependencies

```bash
npm install
```

---

### 2. Create your `.env` file

Create a file called `.env` in the project root (same folder as `monitor.js`):

```env
# Your app name — shown in the email sender name
APP_NAME=PriceWatch

# The Gmail address that sends the alert
EMAIL_FROM_ADDRESS=you@gmail.com

# Where the alert gets delivered (can be the same as above)
EMAIL_TO=you@gmail.com

# Your Gmail address (used for SMTP login)
EMAIL_USER=you@gmail.com

# Your Gmail App Password (16 characters, no spaces)
EMAIL_PASSWORD=abcdefghijklmnop
```

> ⚠️ Never commit your `.env` file. Add it to `.gitignore`.

---

### 3. Get a Gmail App Password

Regular Gmail passwords won't work — you need an **App Password**.

**Requirements:** Your Google account must have 2-Step Verification enabled.

**Steps:**

1. Enable 2-Step Verification (if not already on):
   👉 https://myaccount.google.com/signinoptions/two-step-verification

2. Go to App Passwords:
   👉 https://myaccount.google.com/apppasswords

3. In the text field, type a name like `PriceWatch` and click **Create**

4. Google shows you a **16-character password** in a yellow box — copy it immediately (it won't show again)

5. Paste it into your `.env` as `EMAIL_PASSWORD` with **no spaces**:
   ```
   EMAIL_PASSWORD=abcdefghijklmnop
   ```

---

### 4. Run manually

```bash
node monitor.js
```

Expected output on first run:
```
🔍 PriceWatch starting...

Fetching OpenAI pricing...
  ✅ Found 112 OpenAI model(s) via LiteLLM community JSON.
Fetching Anthropic pricing...
  ✅ Found 19 Anthropic model(s) via LiteLLM community JSON.

✅ No pricing changes detected.
✅ Baseline updated.

Done.
```

---

### 5. Schedule automatic daily checks

**Mac / Linux — cron job:**

Open your crontab:
```bash
crontab -e
```

Add this line to run every day at 9am:
```
0 9 * * * cd /full/path/to/pricewatch && node monitor.js >> /var/log/pricewatch.log 2>&1
```

Replace `/full/path/to/pricewatch` with your actual folder path. To find it, run `pwd` inside the project folder.

**Windows — Task Scheduler:**
- Open Task Scheduler → Create Basic Task
- Trigger: Daily at 9:00 AM
- Action: Start a program
- Program: `node`
- Arguments: `C:\path\to\pricewatch\monitor.js`

---

## Project structure

```
pricewatch/
├── monitor.js              # Main script — fetches, diffs, alerts
├── config.js               # Email configuration (reads from .env)
├── pricing-baseline.json   # Stored pricing snapshot (auto-updated)
├── package.json            # Dependencies
├── .env                    # Your secrets — never commit this!
└── README.md               # This file
```

---

## Email alert

When a price change is detected you'll receive a styled HTML email that includes:

- **Summary badges** — counts of price changes, new models, and removals
- **Color-coded cards** — green for new models, red for removed, yellow for price changes
- **Price diff pills** — shows the exact delta (▲/▼) for each changed model
- **Dark mode support** — automatically adapts to your email client's theme

---

## Troubleshooting

| Error | Fix |
|---|---|
| `Missing credentials for "PLAIN"` | Your `.env` is missing or variables are not loading. Run `node -e "import('dotenv/config').then(() => console.log(process.env.EMAIL_USER))"` to check. |
| `Username and Password not accepted` | You used your regular Gmail password. You need an App Password — see Step 3 above. |
| `0 models found` | The LiteLLM JSON fetch failed. Check your internet connection and try again. |
| Emails going to spam | This is normal for first-time sends. Mark as "Not spam" once and it won't happen again. |
| App Passwords page not found | 2-Step Verification is not enabled on your Google account. Enable it first at https://myaccount.google.com/signinoptions/two-step-verification |

---

## Dependencies

| Package | Purpose |
|---|---|
| `nodemailer` | Sends email via Gmail SMTP |
| `dotenv` | Loads `.env` variables |

Pricing data is fetched via plain `fetch()` — no extra HTTP library needed.
