import assert from "node:assert/strict";
import { DEFAULT_FEATURES, FEATURE_IDS } from "../extension/settings.js";

export async function verifyControlPlane({ extensionRead, pageRead, navigate, startFullscreen, importUI, exportUI, tabId, url }) {
  const call = async (type, values = {}, expected = true) => {
    const response = await extensionRead(async (message) => (globalThis.browser ?? globalThis.chrome).runtime.sendMessage(message), { type, ...values });
    assert.equal(response.ok, expected, response.error);
    return response;
  };
  const status = async () => (await call("status:get", { tabId })).status;
  const host = new URL(url).hostname;
  const original = await call("settings:export");
  try {
    console.log("Control-plane: checking applied status and compatible profile");
    assert.equal((await status()).state, "loaded", "Status confirms applied scripts in the actual HTTP document");
    const compatible = { ...DEFAULT_FEATURES, selection: false, fullscreen: false };
    await call("profile:set", { scope: "site", host, features: compatible });
    assert.equal((await status()).state, "reload", "A settings change does not falsely claim to undo the existing page");
    await navigate(url);
    assert.equal((await status()).state, "loaded");
    const nativeSelection = await pageRead(() => {
      getSelection().selectAllChildren(document.getElementById("sample-text"));
      return { text: String(getSelection()), focusName: Document.prototype.hasFocus.name };
    });
    assert.ok(nativeSelection.text.length > 10, "Editor-compatible selection is native");
    assert.equal(nativeSelection.focusName, "activityShieldHasFocus", "Presence protection remains independently enabled");
    await startFullscreen();
    assert.equal(await pageRead(() => document.documentElement.matches(":fullscreen")), true, "Disabling virtual fullscreen restores native entry");
    await pageRead(async () => { await document.exitFullscreen(); });
    await navigate(url.replace("127.0.0.1", "localhost"));
    assert.equal(await pageRead(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); }), "", "Other hosts keep default selection protection");
    const strict = Object.fromEntries(FEATURE_IDS.map((id) => [id, true]));
    console.log("Control-plane: checking optional event filters");
    await call("profile:set", { scope: "site", host, features: strict });
    await navigate(url);
    assert.equal((await status()).state, "loaded");
    const extra = await pageRead(() => {
      const counts = {};
      for (const type of ["pagehide", "pageshow", "freeze", "resume", "copy", "cut", "mouseout", "pointerout", "beforeunload"]) {
        counts[type] = 0;
        window.addEventListener(type, () => { counts[type]++; }, true);
      }
      const defaults = [];
      for (const type of ["pagehide", "freeze", "resume", "copy", "cut"]) defaults.push(window.dispatchEvent(new Event(type, { cancelable: true })));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      document.body.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: null, bubbles: true }));
      document.body.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null, bubbles: true }));
      const blocked = { ...counts };
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
      document.body.dispatchEvent(new MouseEvent("mouseout", { relatedTarget: document.documentElement, bubbles: true }));
      // Preserve unsaved-work prompts; the lifecycle option must not block them.
      window.dispatchEvent(new Event("beforeunload"));
      document.getElementById("text-input").value = "private-message-do-not-export";
      return { blocked, after: counts, defaults };
    });
    assert.ok(Object.values(extra.blocked).every((value) => value === 0), "Opt-in lifecycle, clipboard and pointer-exit events are filtered");
    assert.ok(extra.defaults.every(Boolean), "Extra filtering does not cancel native defaults");
    assert.equal(extra.after.pageshow, 1, "Initial/non-restored pageshow remains available");
    assert.equal(extra.after.mouseout, 1, "Normal pointer transitions remain available");
    assert.equal(extra.after.beforeunload, 1, "Unsaved-work handlers remain available");
    const report = (await call("diagnostics:get", { tabId })).report;
    const serialized = JSON.stringify(report);
    assert.equal(report.page.state, "loaded");
    for (const value of [host, url, "web.whatsapp.com", "private-message-do-not-export"]) assert.ok(!serialized.includes(value), "Diagnostics omit page/configuration identifiers and contents");
    await call("protection:set", { enabled: false });
    console.log("Control-plane: checking pause, export and import");
    assert.equal((await status()).state, "reload");
    await navigate(url);
    assert.equal((await status()).state, "off", "Pause really stops injection after reload");
    assert.ok((await pageRead(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); })).length > 10);
    const exported = await exportUI();
    console.log("Control-plane: exported JSON download verified");
    assert.equal(JSON.parse(exported).settings.enabled, false);
    assert.equal(JSON.parse(exported).settings.sites[host].lifecycle, true);
    await importUI('{"format":"untrusted"}', false);
    assert.equal((await call("settings:get")).settings.enabled, false, "Invalid import does not mutate settings");
    await importUI(original.text, true);
    console.log("Control-plane: import applied");
    assert.equal((await call("settings:get")).settings.enabled, true);
    assert.equal((await status()).state, "reload");
    await navigate(url);
    assert.equal((await status()).state, "loaded");
    // Fixture an actual legacy 1.0.4 storage layout, then use real migration.
    await extensionRead(async () => {
      const api = globalThis.browser ?? globalThis.chrome;
      await api.storage.local.set({ allowlist: ["legacy.example"] });
      await api.storage.local.remove("settings");
      await api.scripting.registerContentScripts([{ id: "activity-shield", matches: ["http://*/*", "https://*/*"],
        js: ["protections/presence.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: true }]);
    });
    const migrated = (await call("settings:get")).settings;
    assert.deepEqual(migrated.allowlist, ["legacy.example"]);
    assert.deepEqual(migrated.defaults, DEFAULT_FEATURES);
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(await extensionRead(async () => (await (globalThis.browser ?? globalThis.chrome).scripting.getRegisteredContentScripts())
      .some(({ id }) => id === "activity-shield")), false, "Upgrade removes the old monolithic registration");
  } finally {
    await call("settings:import", { text: original.text });
    await navigate(url);
  }
}
