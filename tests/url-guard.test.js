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

test("rejects internal IPv6 hosts when not allowed", () => {
  assert.equal(isAllowedUrl("http://[::1]/h", false), false);          // loopback
  assert.equal(isAllowedUrl("http://[::]/h", false), false);           // unspecified
  assert.equal(isAllowedUrl("http://[fe80::1]/h", false), false);      // link-local
  assert.equal(isAllowedUrl("http://[fc00::1]/h", false), false);      // unique-local
  assert.equal(isAllowedUrl("http://[fd12:3456::1]/h", false), false); // unique-local
  assert.equal(isAllowedUrl("http://[::ffff:127.0.0.1]/h", false), false); // IPv4-mapped loopback
  assert.equal(isAllowedUrl("http://[::ffff:10.0.0.1]/h", false), false);  // IPv4-mapped private
});

test("accepts public IPv6 hosts", () => {
  assert.equal(isAllowedUrl("http://[2606:4700:4700::1111]/h", false), true); // public (Cloudflare DNS)
});

test("IPv4 boundary ranges outside private blocks are allowed", () => {
  assert.equal(isAllowedUrl("http://172.15.0.1/h", false), true);  // just below 172.16/12
  assert.equal(isAllowedUrl("http://172.32.0.1/h", false), true);  // just above 172.31
  assert.equal(isAllowedUrl("http://8.8.8.8/h", false), true);     // public
});
