export const DEFAULT_ALLOWLIST = ["web.whatsapp.com"];
export const SCRIPT_ID = "activity-shield";

// Hostnames, not arbitrary browser match patterns. Include subdomains.
export function normalizeHost(value) {
  const text = String(value ?? "").trim();
  if (!text || /[\s*\\]/u.test(text)) throw new Error("Введите домен, например web.whatsapp.com.");
  let url;
  try { url = new URL(text.includes("://") ? text : `https://${text}`); }
  catch { throw new Error("Не удалось распознать домен."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error("Нужен домен или адрес сайта HTTP(S) без логина и пароля.");
  }
  if (url.hostname.startsWith("[")) throw new Error("IPv6-адреса в списке пока не поддерживаются.");
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host.length > 253 || host.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))) {
    throw new Error("Проверьте написание домена.");
  }
  return host;
}
export function normalizeList(values) {
  if (!Array.isArray(values) || values.length > 500) throw new Error("Допустимо до 500 доменов.");
  return [...new Set(values.map(normalizeHost))].sort();
}
export function matchingRule(host, allowlist) {
  return allowlist.find((rule) => host === rule || host.endsWith(`.${rule}`)) ?? null;
}
export function excludePatterns(allowlist) {
  return allowlist.flatMap((host) => /^\d+\.\d+\.\d+\.\d+$/u.test(host)
    ? [`*://${host}/*`] : [`*://*.${host}/*`]);
}
