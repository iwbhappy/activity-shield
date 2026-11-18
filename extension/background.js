import { SCRIPT_ID, REGISTRATION_PREFIX, FEATURE_IDS, defaultSettings,
  normalizeHost, normalizeList, normalizeFeatures, normalizeSettings, matchingRule,
  effectiveFeatures, registrationGroups, exportSettings, parseSettingsImport } from "./settings.js";
import { diagnosticReport } from "./diagnostics.js";

const api = globalThis.browser ?? globalThis.chrome;
let queue = Promise.resolve();
function serialize(operation) {
  const next = queue.then(operation);
  queue = next.catch(() => {});
  return next;
}
async function readSettings() {
  const stored = await api.storage.local.get(["settings", "allowlist"]);
  if (stored.settings !== undefined) {
    const settings = normalizeSettings(stored.settings);
    if (stored.settings.schemaVersion !== settings.schemaVersion) await api.storage.local.set({ settings });
    return settings;
  }
  const settings = defaultSettings(stored.allowlist === undefined ? undefined : stored.allowlist);
  await api.storage.local.set({ settings, allowlist: settings.allowlist });
  return settings;
}
async function register(settings) {
  const planned = registrationGroups(settings).flatMap((group) => {
    const common = { matches: group.matches, excludeMatches: group.excludeMatches,
      runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true };
    return [
      { ...common, id: `${REGISTRATION_PREFIX}main-${group.mask}`, world: "MAIN",
        js: group.features.map((id) => `protections/${id}.js`) },
      { ...common, id: `${REGISTRATION_PREFIX}report-${group.mask}`, world: "ISOLATED",
        js: ["audit/base.js", ...group.features.map((id) => `audit/${id}.js`)] }
    ];
  });
  const existing = await api.scripting.getRegisteredContentScripts();
  const existingIds = new Set(existing.map(({ id }) => id));
  const create = planned.filter(({ id }) => !existingIds.has(id));
  // Do not rebuild unchanged persistent registrations during startup: a page
  // may already be loading while the worker reconciles its stored settings.
  const update = planned.filter((script) => {
    const current = existing.find(({ id }) => id === script.id);
    return current && Object.entries(script).some(([key, value]) => JSON.stringify(current[key] ?? (Array.isArray(value) ? [] : undefined)) !== JSON.stringify(value));
  });
  if (create.length) await api.scripting.registerContentScripts(create);
  if (update.length) await api.scripting.updateContentScripts(update);
  const wanted = new Set(planned.map(({ id }) => id));
  const obsolete = existing.filter(({ id }) => (id === SCRIPT_ID || id.startsWith(REGISTRATION_PREFIX)) && !wanted.has(id));
  if (obsolete.length) await api.scripting.unregisterContentScripts({ ids: obsolete.map(({ id }) => id) });
}
async function initialize() {
  const settings = await readSettings();
  await register(settings);
  return settings;
}
async function saveSettings(next, previous) {
  const settings = normalizeSettings(next);
  try {
    await register(settings);
    await api.storage.local.set({ settings, allowlist: settings.allowlist });
  } catch (error) {
    await register(previous).catch(console.error);
    throw error;
  }
  return settings;
}

async function inspectTab(tabId, settings = null) {
  const config = settings || await readSettings();
  if (!Number.isInteger(tabId) || tabId < 0) return { state: "unavailable", reloadRequired: false };
  let tab, host;
  try {
    tab = await api.tabs.get(tabId);
    host = normalizeHost(tab.url);
  } catch { return { state: "unavailable", reloadRequired: false }; }
  const wanted = effectiveFeatures(config, host);
  let granted = false;
  try {
    const address = new URL(tab.url);
    granted = await api.permissions.contains({ origins: [`${address.protocol}//${address.hostname}/*`] });
  } catch { /* Protected/internal pages are reported as unavailable below. */ }
  let loaded;
  try {
    const results = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: () => {
      const state = globalThis.__activityShieldLoadV2;
      return state ? { version: state.version, features: { ...state.features } } : null;
    } });
    loaded = results[0]?.result || null;
  } catch { return { state: "no-access", host, wanted, reloadRequired: false, granted }; }
  let checks = null;
  try {
    const results = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN", func: () => {
      const source = (fn) => { try { return Function.prototype.toString.call(fn); } catch { return ""; } };
      const focus = Document.prototype.hasFocus;
      const selection = globalThis.Selection?.prototype.toString;
      const fullscreen = Element.prototype.requestFullscreen;
      return {
        presence: focus.name === "activityShieldHasFocus" || /return true;/.test(source(focus)),
        selection: selection?.name === "activityShieldSelectionToString" || /return "";/.test(source(selection)),
        fullscreen: ["activityShieldRequestFullscreen", "requestVirtualFullscreen"].includes(fullscreen?.name)
      };
    } });
    checks = results[0]?.result || null;
  } catch { /* The isolated load record is still useful, but is not an integrity proof. */ }
  const applied = Object.fromEntries(FEATURE_IDS.map((id) => [id, Boolean(loaded?.features[id])]));
  if (checks) for (const id of ["presence", "selection", "fullscreen"]) applied[id] = Boolean(checks[id]);
  const wantedOn = Object.values(wanted).some(Boolean);
  const appliedOn = Object.values(applied).some(Boolean);
  const versionMismatch = Boolean(loaded && loaded.version !== api.runtime.getManifest().version);
  const mismatch = FEATURE_IDS.some((id) => applied[id] !== wanted[id]);
  const state = !loaded && !appliedOn && wantedOn && !granted ? "no-access"
    : mismatch || versionMismatch ? "reload" : wantedOn ? "loaded" : "off";
  return { state, host, wanted, applied, checks, loadedVersion: loaded?.version || null,
    reloadRequired: state === "reload", granted, paused: !config.enabled,
    rule: matchingRule(host, config.allowlist), hasProfile: Object.hasOwn(config.sites, host) };
}
async function badge(tabId, status) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const values = { loaded: ["ON", "#167345"], off: ["OFF", "#64748b"], reload: ["R", "#a15c00"],
    "no-access": ["?", "#64748b"], unavailable: ["", "#64748b"] };
  const [text, color] = values[status.state] || values.unavailable;
  try {
    await api.action.setBadgeText({ tabId, text });
    await api.action.setBadgeBackgroundColor({ tabId, color });
  } catch { /* Some mobile browser interfaces do not display badges. */ }
}
async function refreshActiveBadges() {
  const tabs = await api.tabs.query({ active: true });
  for (const tab of tabs) await badge(tab.id, await inspectTab(tab.id));
}
async function handle(message) {
  if (message.type === "settings:get") {
    const settings = await initialize();
    return { settings, allowlist: settings.allowlist };
  }
  if (message.type === "status:get") {
    const status = await inspectTab(message.tabId);
    await badge(message.tabId, status);
    return { status };
  }
  const previous = await readSettings();
  if (message.type === "settings:export") return { text: exportSettings(previous) };
  if (message.type === "diagnostics:get") {
    const status = await inspectTab(message.tabId, previous);
    let browser = { name: "Chromium", version: /(?:Chrome|Chromium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] || "unknown" };
    if (api.runtime.getBrowserInfo) {
      const info = await api.runtime.getBrowserInfo();
      browser = { name: info.name, version: info.version };
    }
    return { report: diagnosticReport({ version: api.runtime.getManifest().version, browser, settings: previous, status }) };
  }
  let next = structuredClone(previous);
  if (["allowlist:add", "allowlist:remove"].includes(message.type)) {
    const host = normalizeHost(message.host);
    next.allowlist = message.type === "allowlist:add" ? normalizeList([...next.allowlist, host]) : next.allowlist.filter((entry) => entry !== host);
  } else if (message.type === "profile:set") {
    const flags = normalizeFeatures(message.features);
    if (message.scope === "default") next.defaults = flags;
    else if (message.scope === "site") next.sites[normalizeHost(message.host)] = flags;
    else throw new Error("Неизвестная область настроек.");
  } else if (message.type === "profile:reset") {
    delete next.sites[normalizeHost(message.host)];
  } else if (message.type === "protection:set") {
    if (typeof message.enabled !== "boolean") throw new Error("Неверное состояние паузы.");
    next.enabled = message.enabled;
  } else if (message.type === "settings:import") {
    next = parseSettingsImport(message.text);
  } else throw new Error("Неизвестная команда.");
  const settings = await saveSettings(next, previous);
  return { settings, allowlist: settings.allowlist };
}
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(""))) return false;
  serialize(() => handle(message)).then(
    (result) => { sendResponse({ ok: true, ...result }); refreshActiveBadges().catch(() => {}); },
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
});
function reconcile() { serialize(initialize).then(refreshActiveBadges).catch(console.error); }
api.runtime.onInstalled.addListener(reconcile);
api.runtime.onStartup.addListener(reconcile);
api.tabs.onActivated.addListener(({ tabId }) => { queue.then(() => inspectTab(tabId)).then((status) => badge(tabId, status)).catch(() => {}); });
api.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete") queue.then(() => inspectTab(tabId)).then((status) => badge(tabId, status)).catch(() => {});
});
reconcile();
