import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { sign, nextRetry } from "../delivery.js";

test("sign produces sha256= HMAC matching node:crypto", () => {
  const body = JSON.stringify({ a: 1 });
  const secret = "abc123";
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(sign(body, secret), expected);
});

test("nextRetry schedules another attempt below the cap", () => {
  const now = new Date("2026-05-30T00:00:00.000Z");
  const decision = nextRetry({ attempts: 1 }, { maxRetries: 3, retryDelayMs: 21_600_000, now });
  assert.equal(decision.drop, false);
  assert.equal(decision.attempts, 2);
  assert.equal(decision.nextAttempt, "2026-05-30T06:00:00.000Z");
});

test("nextRetry drops once attempts exceed maxRetries", () => {
  const now = new Date("2026-05-30T00:00:00.000Z");
  const decision = nextRetry({ attempts: 3 }, { maxRetries: 3, retryDelayMs: 21_600_000, now });
  assert.equal(decision.drop, true);
});
