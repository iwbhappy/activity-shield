import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHost, normalizeList, matchingRule, excludePatterns } from "../extension/settings.js";
import { DEFAULT_FEATURES, FEATURE_IDS, defaultSettings, normalizeSettings, effectiveFeatures,
  registrationGroups, featureMask, exportSettings, parseSettingsImport } from "../extension/settings.js";
import { diagnosticReport } from "../extension/diagnostics.js";

test("Allowlist normalizes URLs and IDNs without accepting browser match patterns", () => {
  assert.equal(normalizeHost(" HTTPS://Web.WhatsApp.com:443/path?q=1 "), "web.whatsapp.com");
  assert.equal(normalizeHost("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  assert.equal(normalizeHost("localhost:8080"), "localhost");
  assert.deepEqual(normalizeList(["EXAMPLE.com", "https://example.com/", "web.whatsapp.com"]), ["example.com", "web.whatsapp.com"]);
  for (const value of ["*", "*.example.com", "<all_urls>", "javascript:alert(1)", "file:///tmp/a", "https://user:pass@example.com", "a b.com", "https://[::1]"]) {
    assert.throws(() => normalizeHost(value), undefined, value);
  }
});

test("Profiles are exact-host overrides, allowlist includes subdomains, pause overrides everything", () => {
  const settings = defaultSettings([]);
  settings.sites["example.com"] = { ...DEFAULT_FEATURES, selection: false, fullscreen: false };
  assert.equal(effectiveFeatures(settings, "example.com").selection, false);
  assert.equal(effectiveFeatures(settings, "child.example.com").selection, true);
  assert.equal(effectiveFeatures(settings, "example.com").presence, true);
  settings.allowlist = ["example.com"];
  assert.ok(Object.values(effectiveFeatures(settings, "child.example.com")).every((flag) => !flag));
  settings.enabled = false;
  assert.ok(Object.values(effectiveFeatures(settings, "unrelated.test")).every((flag) => !flag));
  assert.deepEqual(registrationGroups(settings), []);
});

test("Registration separates default protection, editor profile, fully disabled host and empty defaults", () => {
  const settings = defaultSettings(["web.whatsapp.com"]);
  settings.sites["editor.test"] = { ...DEFAULT_FEATURES, selection: false };
  settings.sites["off.test"] = Object.fromEntries(FEATURE_IDS.map((id) => [id, false]));
  settings.sites["same.test"] = { ...DEFAULT_FEATURES };
  const groups = registrationGroups(settings);
  assert.equal(groups.length, 2);
  const base = groups.find((group) => group.mask === featureMask(DEFAULT_FEATURES));
  assert.ok(base.excludeMatches.includes("*://editor.test/*"));
  assert.ok(base.excludeMatches.includes("*://off.test/*"));
  assert.ok(!base.excludeMatches.includes("*://same.test/*"));
  assert.ok(base.excludeMatches.includes("*://*.web.whatsapp.com/*"));
  assert.deepEqual(groups.find((group) => !group.features.includes("selection")).matches, ["*://editor.test/*"]);
  settings.defaults = Object.fromEntries(FEATURE_IDS.map((id) => [id, false]));
  assert.ok(registrationGroups(settings).every((group) => !group.matches.includes("http://*/*")));
});

test("Backup round-trip preserves pause, deleted default exclusion and site flags", () => {
  const settings = defaultSettings([]);
  settings.enabled = false;
  settings.sites["example.com"] = { ...DEFAULT_FEATURES, lifecycle: true };
  assert.deepEqual(parseSettingsImport(exportSettings(settings)), settings);
  assert.deepEqual(normalizeSettings(settings).allowlist, []);
});

test("Import rejects scripts, oversized data, unknown schema, non-boolean flags and prototype keys", () => {
  assert.throws(() => parseSettingsImport("alert(1)"));
  assert.throws(() => parseSettingsImport("x".repeat(1_000_001)));
  const valid = JSON.parse(exportSettings(defaultSettings()));
  for (const alter of [
    (value) => { value.settings.schemaVersion = 999; },
    (value) => { value.settings.defaults.presence = "true"; },
    (value) => { value.settings.defaults.code = "alert(1)"; },
    (value) => { value.settings.sites["*.example.com"] = { ...DEFAULT_FEATURES }; },
    (value) => { value.settings.sites["example.com"] = { presence: true }; }
  ]) {
    const changed = structuredClone(valid); alter(changed);
    assert.throws(() => parseSettingsImport(JSON.stringify(changed)));
  }
  assert.throws(() => parseSettingsImport('{"format":"activity-shield-settings","formatVersion":1,"__proto__":{},"settings":{}}'));
  assert.equal({}.polluted, undefined);
});

test("Diagnostic export does not leak domain names, URLs, text or exception messages", () => {
  const settings = defaultSettings(["private.example"]);
  settings.sites["secret.example"] = { ...DEFAULT_FEATURES };
  const report = diagnosticReport({ version: "1.1.0", browser: { name: "Firefox", version: "159" }, settings,
    status: { state: "reload", host: "secret.example", url: "https://secret.example/chat", selectedText: "private-message",
      error: "Visit https://private.example", wanted: DEFAULT_FEATURES, applied: {}, reloadRequired: true } });
  const serialized = JSON.stringify(report);
  for (const forbidden of ["private.example", "secret.example", "private-message", "https://"]) assert.ok(!serialized.includes(forbidden));
  assert.equal(report.settings.allowlistCount, 1);
  assert.equal(report.settings.siteProfileCount, 1);
  assert.equal(report.page.reloadRequired, true);
});
test("Allowlist applies at domain boundaries and does not expand IPv4 into subdomains", () => {
  assert.equal(matchingRule("chat.example.com", ["example.com"]), "example.com");
  assert.equal(matchingRule("example.com.evil.test", ["example.com"]), null);
  assert.equal(matchingRule("notexample.com", ["example.com"]), null);
  assert.deepEqual(excludePatterns(["example.com", "127.0.0.1"]), ["*://*.example.com/*", "*://127.0.0.1/*"]);
});
