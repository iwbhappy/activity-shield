import { normalizeHost, matchingRule } from "./settings.js";
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
let tab = null;
let host = null;
let allowlist = [];
let busy = false;
async function request(type, values = {}) {
  const response = await api.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || "Не удалось загрузить настройки.");
  return response;
}
function render() {
  const rule = host && matchingRule(host, allowlist);
  $("current-host").textContent = host || "Откройте обычный сайт HTTP(S), затем меню расширения.";
  $("site-state").textContent = host ? rule
    ? `Для новых загрузок: защита отключена (правило ${rule}).`
    : "Для новых загрузок: защита включена при разрешённом доступе к сайту." : "";
  $("toggle-site").disabled = !host || busy;
  $("toggle-site").textContent = rule ? "Убрать правило и включить защиту" : "Отключить защиту на этом домене";
  $("allowlist").replaceChildren();
  for (const entry of allowlist) {
    const row = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = entry;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Удалить";
    remove.disabled = busy;
    remove.setAttribute("aria-label", `Удалить ${entry}`);
    remove.addEventListener("click", () => change("allowlist:remove", entry));
    row.append(name, remove);
    $("allowlist").append(row);
  }
  $("domain").disabled = busy;
  document.querySelector('button[type="submit"]').disabled = busy;
}
async function change(type, domain) {
  if (busy) return;
  busy = true;
  render();
  try {
    allowlist = (await request(type, { host: domain })).allowlist;
    $("message").textContent = "Сохранено. Перезагрузите уже открытые страницы этого домена.";
    $("reload-tab").hidden = !tab?.id || !host;
    $("domain").value = "";
  } catch (error) { $("message").textContent = error.message; }
  finally { busy = false; render(); }
}
$("toggle-site").addEventListener("click", () => {
  const rule = matchingRule(host, allowlist);
  change(rule ? "allowlist:remove" : "allowlist:add", rule || host);
});
$("add-domain").addEventListener("submit", (event) => {
  event.preventDefault();
  try { change("allowlist:add", normalizeHost($("domain").value)); }
  catch (error) { $("message").textContent = error.message; }
});
$("reload-tab").addEventListener("click", async () => {
  try { await api.tabs.reload(tab.id); window.close(); }
  catch (error) { $("message").textContent = error.message; }
});
try {
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  try { host = normalizeHost(tab?.url); } catch { host = null; }
  allowlist = (await request("settings:get")).allowlist;
  render();
} catch (error) {
  $("current-host").textContent = "Не удалось загрузить настройки.";
  $("message").textContent = error.message;
}
