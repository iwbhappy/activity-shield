import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, normalizeList, matchingRule, excludePatterns } from "../extension/settings.js";

test("Allowlist normalizes URLs and IDNs without accepting browser match patterns", () => {
  assert.equal(normalizeHost(" HTTPS://Web.WhatsApp.com:443/path?q=1 "), "web.whatsapp.com");
  assert.equal(normalizeHost("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  assert.equal(normalizeHost("localhost:8080"), "localhost");
  assert.deepEqual(normalizeList(["EXAMPLE.com", "https://example.com/", "web.whatsapp.com"]), ["example.com", "web.whatsapp.com"]);
  for (const value of ["*", "*.example.com", "<all_urls>", "javascript:alert(1)", "file:///tmp/a", "https://user:pass@example.com", "a b.com", "https://[::1]"]) {
    assert.throws(() => normalizeHost(value), undefined, value);
  }
});
test("Allowlist applies at domain boundaries and does not expand IPv4 into subdomains", () => {
  assert.equal(matchingRule("chat.example.com", ["example.com"]), "example.com");
  assert.equal(matchingRule("example.com.evil.test", ["example.com"]), null);
  assert.equal(matchingRule("notexample.com", ["example.com"]), null);
  assert.deepEqual(excludePatterns(["example.com", "127.0.0.1"]), ["*://*.example.com/*", "*://127.0.0.1/*"]);
});
