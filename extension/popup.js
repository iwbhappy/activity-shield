import { FEATURES, FEATURE_IDS, DEFAULT_FEATURES, MAX_BACKUP_SIZE, normalizeHost, matchingRule, parseSettingsImport } from "./settings.js";
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
let tab = null, host = null, settings = null, status = null;
let busy = true, pendingImport = null, reportText = null;

async function request(type, values = {}) {
  const response = await api.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || "Не удалось загрузить настройки.");
  return response;
}
function renderFeatures() {
  if (!settings) return;
  const siteScope = $("feature-scope").value === "site";
  const own = host && Object.hasOwn(settings.sites, host);
  const flags = siteScope && own ? settings.sites[host] : settings.defaults;
  for (const id of FEATURE_IDS) $(`feature-${id}`).checked = flags[id];
  $("profile-note").textContent = siteScope ? own
    ? "Задан отдельный профиль этого домена. Он не распространяется на поддомены."
    : "Сейчас используются общие настройки. Сохранение создаст профиль только этого домена."
    : "Эти настройки действуют на сайты без собственного профиля и вне белого списка.";
  $("reset-features").hidden = !siteScope || !own;
}
function renderStatus() {
  $("current-host").textContent = host || "Откройте сайт HTTP(S) и разрешите расширению доступ к нему.";
  const labels = {
    loaded: "Скрипты защиты загружены.",
    reload: "Нужна перезагрузка: настройки и загруженная защита различаются.",
    "no-access": "Нет доступа для проверки страницы. Разрешите доступ к сайту в настройках браузера.",
    unavailable: "Эту страницу проверить нельзя: служебная страница или нет доступа к её адресу."
  };
  $("site-state").textContent = !status ? "Проверка загрузки защиты…" : status.state === "off"
    ? !settings.enabled ? "Общая пауза: на этой странице защита не загружена."
      : status.rule ? "Сайт в белом списке: защита не загружена." : "Все функции для этой страницы отключены."
    : labels[status.state] || "Не удалось определить состояние.";
  const applied = status?.applied && FEATURES.filter(({ id }) => status.applied[id]).map(({ label }) => label);
  $("applied-summary").textContent = applied?.length ? `Отмечены как загруженные: ${applied.join(", ")}.` : "";
  $("reload-tab").hidden = !host || !status?.reloadRequired;
  $("grant-access").hidden = !host || status?.state !== "no-access";
}
function render() {
  if (!settings) return;
  const rule = host && matchingRule(host, settings.allowlist);
  $("pause-protection").textContent = settings.enabled ? "Пауза на всех сайтах" : "Возобновить защиту";
  $("pause-protection").setAttribute("aria-pressed", String(!settings.enabled));
  $("toggle-site").textContent = rule ? "Убрать правило и включить защиту" : "Отключить защиту на этом домене";
  $("allowlist").replaceChildren();
  for (const entry of settings.allowlist) {
    const row = document.createElement("li"), name = document.createElement("span"), remove = document.createElement("button");
    name.textContent = entry;
    remove.type = "button"; remove.textContent = "Удалить";
    remove.setAttribute("aria-label", `Удалить ${entry}`);
    remove.addEventListener("click", () => mutate("allowlist:remove", { host: entry }));
    row.append(name, remove); $("allowlist").append(row);
  }
  for (const control of document.querySelectorAll("button, select, input")) control.disabled = busy;
  $("toggle-site").disabled = busy || !host;
  $("feature-scope").querySelector('[value="site"]').disabled = !host;
  if (!host && $("feature-scope").value === "site") $("feature-scope").value = "default";
  renderStatus();
}
async function refreshStatus() {
  try { status = (await request("status:get", { tabId: tab?.id })).status; }
  catch { status = { state: "unavailable", reloadRequired: false }; }
  renderStatus();
}
async function mutate(type, values = {}) {
  if (busy) return;
  busy = true; render();
  try {
    settings = (await request(type, values)).settings;
    $("message").textContent = "Сохранено. Обновите уже открытые страницы, чтобы применить изменения.";
    $("domain").value = "";
    renderFeatures();
    await refreshStatus();
    return true;
  } catch (error) { $("message").textContent = error.message; return false; }
  finally { busy = false; render(); }
}
function flagsFromForm() { return Object.fromEntries(FEATURE_IDS.map((id) => [id, $(`feature-${id}`).checked])); }
function download(name, text) {
  const address = URL.createObjectURL(new Blob([text + "\n"], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = address; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(address), 10_000);
}
function clearImport() {
  pendingImport = null;
  $("import-file").value = ""; $("import-preview").textContent = "";
  $("apply-import").hidden = true; $("cancel-import").hidden = true;
}
for (const feature of FEATURES) {
  const label = document.createElement("label"), input = document.createElement("input"), text = document.createElement("span"), note = document.createElement("small");
  label.className = "feature"; input.type = "checkbox"; input.id = `feature-${feature.id}`;
  text.textContent = feature.label; note.textContent = feature.detail;
  label.append(input, text, note); $("features").append(label);
}
$("feature-scope").addEventListener("change", renderFeatures);
$("save-features").addEventListener("click", () => mutate("profile:set", { scope: $("feature-scope").value, host, features: flagsFromForm() }));
$("reset-features").addEventListener("click", () => mutate("profile:reset", { host }));
$("compatible-profile").addEventListener("click", () => {
  for (const id of FEATURE_IDS) $(`feature-${id}`).checked = ["presence", "contextMenu"].includes(id);
  $("message").textContent = "Совместимый профиль выбран. Нажмите «Сохранить защиту».";
});
$("strict-profile").addEventListener("click", () => {
  for (const id of FEATURE_IDS) $(`feature-${id}`).checked = true;
  $("message").textContent = "Все фильтры выбраны. Дополнительные фильтры могут мешать сайтам. Нажмите «Сохранить защиту».";
});
$("pause-protection").addEventListener("click", () => mutate("protection:set", { enabled: !settings.enabled }));
$("toggle-site").addEventListener("click", () => {
  const rule = matchingRule(host, settings.allowlist);
  mutate(rule ? "allowlist:remove" : "allowlist:add", { host: rule || host });
});
$("add-domain").addEventListener("submit", (event) => {
  event.preventDefault();
  try { mutate("allowlist:add", { host: normalizeHost($("domain").value) }); }
  catch (error) { $("message").textContent = error.message; }
});
$("refresh-status").addEventListener("click", refreshStatus);
$("reload-tab").addEventListener("click", async () => {
  try { await api.tabs.reload(tab.id); window.close(); }
  catch (error) { $("message").textContent = error.message; }
});
$("grant-access").addEventListener("click", async () => {
  try {
    const address = new URL(tab.url);
    const granted = await api.permissions.request({ origins: [`${address.protocol}//${address.hostname}/*`] });
    $("message").textContent = granted ? "Доступ предоставлен. Обновите страницу." : "Доступ не предоставлен.";
    await refreshStatus();
  } catch { $("message").textContent = "Измените доступ к сайту в настройках расширения браузера."; }
});
$("export-settings").addEventListener("click", async () => {
  try { download("activity-shield-settings.json", (await request("settings:export")).text); }
  catch (error) { $("message").textContent = error.message; }
});
$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_BACKUP_SIZE) throw new Error("Файл больше 1 МБ.");
    const text = await file.text();
    const imported = parseSettingsImport(text);
    pendingImport = text;
    $("import-preview").textContent = `Будут заменены все настройки: исключений ${imported.allowlist.length}, профилей ${Object.keys(imported.sites).length}. Общая защита ${imported.enabled ? "включена" : "на паузе"}.`;
    $("apply-import").hidden = false; $("cancel-import").hidden = false;
  } catch (error) { clearImport(); $("import-preview").textContent = error.message; }
});
$("apply-import").addEventListener("click", async () => {
  if (pendingImport && await mutate("settings:import", { text: pendingImport })) clearImport();
});
$("cancel-import").addEventListener("click", clearImport);
$("make-diagnostics").addEventListener("click", async () => {
  try {
    reportText = JSON.stringify((await request("diagnostics:get", { tabId: tab?.id })).report, null, 2);
    $("diagnostics-text").value = reportText;
    $("diagnostics-text").hidden = false; $("download-diagnostics").hidden = false;
  } catch (error) { $("message").textContent = error.message; }
});
$("download-diagnostics").addEventListener("click", () => { if (reportText) download("activity-shield-diagnostics.json", reportText); });

try {
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try { host = normalizeHost(tab?.url); } catch { host = null; }
  settings = (await request("settings:get")).settings;
  busy = false; render(); renderFeatures();
  await refreshStatus();
} catch (error) {
  $("current-host").textContent = "Не удалось загрузить настройки.";
  $("message").textContent = error.message;
}
