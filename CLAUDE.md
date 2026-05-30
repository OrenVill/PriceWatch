# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # install dependencies
node server.js       # start the API server (production)
node --watch server.js  # start with auto-restart on file changes (dev)
node monitor.js      # run the one-shot pricing monitor manually
```

No test suite exists. Verify behavior by hitting the API endpoints directly.

## Architecture

Two independent entry points share `config.js` for SMTP settings:

**`server.js`** — long-running Express API. Fetches LiteLLM pricing on boot, holds it in a module-level `cache` object, and refreshes every hour via `setInterval`. Price diffs are computed against the previous in-memory snapshot. Email alerts fire automatically when diffs are found.

**`monitor.js`** — one-shot script intended for cron (`0 9 * * *`). Loads a file-based baseline from `pricing-baseline.json`, fetches current prices, diffs, emails, then overwrites the baseline. Exits with code `1` if changes were found, `0` if not.

Both scripts fetch from the same upstream source: the LiteLLM community JSON at `BerriAI/litellm` on GitHub. Model classification is prefix-based: `gpt-`, `o1`, `o3`, `o4`, `chatgpt` → OpenAI; `claude` → Anthropic. All other models are silently dropped.

Prices are stored as **$/1M tokens** (raw `input_cost_per_token × 1_000_000`), rounded to 4 decimal places.

## Key constraints

- The project uses ES modules (`"type": "module"` in `package.json`). Use `import`/`export`; no `require()`.
- No database — the server's state is entirely in the `cache` variable. A restart clears it and triggers a fresh fetch.
- Email is configured via environment variables in `.env` (see `.env.example`). `config.email.enabled` must be `true` for alerts to send. SMTP is hardcoded to Gmail on port 587.
- The `/health` endpoint is intentionally unauthenticated; all `/prices` routes are also currently open.
