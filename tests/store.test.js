import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pricewatch-test-"));
}

test("readJson returns fallback when file is missing", async () => {
  const store = createStore(tmpDir());
  assert.deepEqual(await store.readJson("nope.json", { a: 1 }), { a: 1 });
});

test("writeJson then readJson round-trips, and file exists on disk", async () => {
  const dir = tmpDir();
  const store = createStore(dir);
  await store.writeJson("data.json", { hello: "world" });
  assert.deepEqual(await store.readJson("data.json", null), { hello: "world" });
  assert.ok(fs.existsSync(path.join(dir, "data.json")));
});

test("readJson recovers from corrupt file by returning fallback", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  const store = createStore(dir);
  assert.deepEqual(await store.readJson("bad.json", { ok: true }), { ok: true });
});

test("subscriber CRUD: add, getById, list, remove", async () => {
  const store = createStore(tmpDir());
  const sub = await store.addSubscriber({ url: "https://x.test/h", providers: ["openai"], secret: "s", challenge: "c" });
  assert.ok(sub.id);
  assert.equal(sub.status, "pending");
  assert.equal((await store.getSubscriber(sub.id)).url, "https://x.test/h");

  await store.updateSubscriber(sub.id, { status: "active", challenge: null });
  assert.equal((await store.getSubscriber(sub.id)).status, "active");

  assert.equal((await store.listSubscribers()).length, 1);
  assert.equal(await store.removeSubscriber(sub.id), true);
  assert.equal((await store.listSubscribers()).length, 0);
  assert.equal(await store.removeSubscriber(sub.id), false);
});

test("retry queue: enqueue, due selection, update, drop", async () => {
  const store = createStore(tmpDir());
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const a = await store.enqueueRetry({ subscriberId: "1", url: "u", payload: {}, nextAttempt: past });
  await store.enqueueRetry({ subscriberId: "2", url: "u", payload: {}, nextAttempt: future });

  const due = await store.dueRetries(new Date());
  assert.equal(due.length, 1);
  assert.equal(due[0].deliveryId, a.deliveryId);

  await store.updateRetry(a.deliveryId, { attempts: 2, nextAttempt: future });
  assert.equal((await store.dueRetries(new Date())).length, 0);

  await store.dropRetry(a.deliveryId);
  assert.equal((await store.listRetries()).length, 1);
});

test("concurrent writes do not lose updates (mutex serializes)", async () => {
  const store = createStore(tmpDir());
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.addSubscriber({ url: `https://x.test/${i}`, providers: ["openai"], secret: "s", challenge: "c" })
    )
  );
  assert.equal((await store.listSubscribers()).length, 20);
});
