/**
 * Atomic JSON-file persistence for subscribers, the retry queue, and the pricing
 * baseline. All read-modify-write operations are serialized through an in-process
 * mutex (a promise chain) so concurrent calls cannot interleave or lose writes.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SUBSCRIBERS = "subscribers.json";
const RETRY_QUEUE = "retry-queue.json";

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let lock = Promise.resolve();

  // Serialize every mutating section behind a single promise chain.
  function withLock(fn) {
    const run = lock.then(fn, fn);
    lock = run.then(() => {}, () => {});
    return run;
  }

  async function readJson(name, fallback) {
    const file = path.join(dir, name);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  async function writeJson(name, value) {
    const file = path.join(dir, name);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
  }

  // ── Subscribers ──────────────────────────────────────────────────────────
  async function listSubscribers() {
    return (await readJson(SUBSCRIBERS, { subscribers: [] })).subscribers;
  }
  async function getSubscriber(id) {
    return (await listSubscribers()).find((s) => s.id === id) ?? null;
  }
  function addSubscriber(input) {
    return withLock(async () => {
      const data = await readJson(SUBSCRIBERS, { subscribers: [] });
      const sub = {
        id: randomUUID(),
        url: input.url,
        providers: input.providers,
        secret: input.secret,
        status: "pending",
        challenge: input.challenge,
        createdAt: new Date().toISOString(),
        verifiedAt: null,
      };
      data.subscribers.push(sub);
      await writeJson(SUBSCRIBERS, data);
      return sub;
    });
  }
  function updateSubscriber(id, patch) {
    return withLock(async () => {
      const data = await readJson(SUBSCRIBERS, { subscribers: [] });
      const sub = data.subscribers.find((s) => s.id === id);
      if (!sub) return null;
      Object.assign(sub, patch);
      await writeJson(SUBSCRIBERS, data);
      return sub;
    });
  }
  function removeSubscriber(id) {
    return withLock(async () => {
      const data = await readJson(SUBSCRIBERS, { subscribers: [] });
      const before = data.subscribers.length;
      data.subscribers = data.subscribers.filter((s) => s.id !== id);
      await writeJson(SUBSCRIBERS, data);
      return data.subscribers.length < before;
    });
  }

  // ── Retry queue ──────────────────────────────────────────────────────────
  async function listRetries() {
    return (await readJson(RETRY_QUEUE, { pending: [] })).pending;
  }
  function enqueueRetry(input) {
    return withLock(async () => {
      const data = await readJson(RETRY_QUEUE, { pending: [] });
      const item = {
        deliveryId: randomUUID(),
        subscriberId: input.subscriberId,
        url: input.url,
        payload: input.payload,
        attempts: input.attempts ?? 1,
        nextAttempt: input.nextAttempt,
        lastError: input.lastError ?? null,
      };
      data.pending.push(item);
      await writeJson(RETRY_QUEUE, data);
      return item;
    });
  }
  function updateRetry(deliveryId, patch) {
    return withLock(async () => {
      const data = await readJson(RETRY_QUEUE, { pending: [] });
      const item = data.pending.find((p) => p.deliveryId === deliveryId);
      if (!item) return null;
      Object.assign(item, patch);
      await writeJson(RETRY_QUEUE, data);
      return item;
    });
  }
  function dropRetry(deliveryId) {
    return withLock(async () => {
      const data = await readJson(RETRY_QUEUE, { pending: [] });
      data.pending = data.pending.filter((p) => p.deliveryId !== deliveryId);
      await writeJson(RETRY_QUEUE, data);
    });
  }
  async function dueRetries(now) {
    const ts = now.getTime();
    return (await listRetries()).filter((p) => new Date(p.nextAttempt).getTime() <= ts);
  }

  return {
    readJson, writeJson,
    listSubscribers, getSubscriber, addSubscriber, updateSubscriber, removeSubscriber,
    listRetries, enqueueRetry, updateRetry, dropRetry, dueRetries,
  };
}
