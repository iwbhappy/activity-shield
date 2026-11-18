import { DEFAULT_ALLOWLIST, SCRIPT_ID, normalizeHost, normalizeList, excludePatterns } from "./settings.js";

const api = globalThis.browser ?? globalThis.chrome;
let queue = Promise.resolve();
function serialize(operation) {
  const next = queue.then(operation);
  queue = next.catch(() => {});
  return next;
}
async function readAllowlist() {
  const stored = await api.storage.local.get("allowlist");
  if (stored.allowlist === undefined) {
    await api.storage.local.set({ allowlist: DEFAULT_ALLOWLIST });
    return [...DEFAULT_ALLOWLIST];
  }
  return normalizeList(stored.allowlist);
}
async function register(allowlist) {
  const script = {
    id: SCRIPT_ID, matches: ["http://*/*", "https://*/*"],
    excludeMatches: excludePatterns(allowlist), js: ["shield.js"],
    runAt: "document_start", world: "MAIN", allFrames: true,
    matchOriginAsFallback: true, persistAcrossSessions: true
  };
  const existing = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await api.scripting.updateContentScripts([script]);
  else await api.scripting.registerContentScripts([script]);
}
async function initialize() {
  const allowlist = await readAllowlist();
  await register(allowlist);
  return allowlist;
}
async function handle(message) {
  if (message.type === "settings:get") return { allowlist: await initialize() };
  if (!["allowlist:add", "allowlist:remove"].includes(message.type)) throw new Error("Неизвестная команда.");
  const host = normalizeHost(message.host);
  const previous = await readAllowlist();
  const allowlist = message.type === "allowlist:add"
    ? normalizeList([...previous, host]) : previous.filter((entry) => entry !== host);
  // A successful reply means the exclusion is registered before a reload.
  await register(allowlist);
  try { await api.storage.local.set({ allowlist }); }
  catch (error) { await register(previous); throw error; }
  return { allowlist };
}
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only extension pages can change settings, never a site's content script.
  if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(""))) return false;
  serialize(() => handle(message)).then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error.message })
  );
  return true;
});
api.runtime.onInstalled.addListener(() => { serialize(initialize).catch(console.error); });
api.runtime.onStartup.addListener(() => { serialize(initialize).catch(console.error); });
// Registrations persist across restarts. Reconcile on event-page/worker start.
serialize(initialize).catch(console.error);
