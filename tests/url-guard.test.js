import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedUrl } from "../url-guard.js";

test("accepts public http/https URLs", () => {
  assert.equal(isAllowedUrl("https://example.com/hook", false), true);
  assert.equal(isAllowedUrl("http://1.2.3.4/hook", false), true);
});

test("rejects non-http(s) schemes", () => {
  assert.equal(isAllowedUrl("ftp://example.com", false), false);
  assert.equal(isAllowedUrl("not a url", false), false);
});

test("rejects internal/private hosts when not allowed", () => {
  assert.equal(isAllowedUrl("http://localhost/h", false), false);
  assert.equal(isAllowedUrl("http://127.0.0.1/h", false), false);
  assert.equal(isAllowedUrl("http://10.0.0.5/h", false), false);
  assert.equal(isAllowedUrl("http://192.168.1.1/h", false), false);
  assert.equal(isAllowedUrl("http://169.254.1.1/h", false), false);
});

test("allows private hosts when allowPrivate is true", () => {
  assert.equal(isAllowedUrl("http://localhost:9999/h", true), true);
});
