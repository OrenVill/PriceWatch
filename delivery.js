/**
 * Webhook delivery: HMAC signing, signed POST with timeout, registration
 * verification ping, and the pure retry-scheduling decision.
 */
import crypto from "node:crypto";

export function sign(rawBody, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Decide what happens to a retry item after a failed attempt.
 * `item.attempts` is the number of attempts made so far (initial delivery = 1).
 * Returns { drop: true } once we have exhausted initial + maxRetries attempts.
 */
export function nextRetry(item, { maxRetries, retryDelayMs, now }) {
  const attempts = item.attempts + 1;
  if (attempts > maxRetries) return { drop: true };
  return {
    drop: false,
    attempts,
    nextAttempt: new Date(now.getTime() + retryDelayMs).toISOString(),
  };
}

/**
 * POST a signed event. Returns { ok, status, error }. Never throws.
 */
export async function postEvent({ url, event, payload, secret, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const rawBody = JSON.stringify(payload);
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-PriceWatch-Event": event,
        "X-PriceWatch-Delivery": payload.deliveryId ?? "",
        "X-PriceWatch-Timestamp": new Date().toISOString(),
        "X-PriceWatch-Signature": sign(rawBody, secret),
      },
      body: rawBody,
    });
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => "") };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the verification ping during registration. The receiver must return 2xx
 * AND echo the challenge in its JSON body. Returns true on success.
 */
export async function sendVerification({ url, id, challenge, secret, timeoutMs }) {
  const res = await postEvent({
    url,
    event: "verification",
    payload: { type: "verification", id, challenge, secret },
    secret,
    timeoutMs,
  });
  if (!res.ok) return false;
  try {
    return JSON.parse(res.body)?.challenge === challenge;
  } catch {
    return false;
  }
}
