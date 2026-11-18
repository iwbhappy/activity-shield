export const DEFAULT_ALLOWLIST = ["web.whatsapp.com"];
export const SCRIPT_ID = "activity-shield";
export const REGISTRATION_PREFIX = "activity-shield-v2-";
export const SETTINGS_SCHEMA = 3;
export const MAX_BACKUP_SIZE = 1_000_000;
export const FEATURES = [
  { id: "presence", label: "Видимость и фокус", detail: "Сайт получает visible / true при переключении вкладки или приложения.", default: true },
  { id: "selection", label: "Скрывать выделение", detail: "Может мешать редакторам. Отключите для нормального ввода в них.", default: true },
  { id: "contextMenu", label: "Скрывать ПКМ", detail: "Фильтрует события правой кнопки и клавиши контекстного меню.", default: true },
  { id: "fullscreen", label: "Синтетический полный экран", detail: "Запрос сайта успешен, но окно не разворачивается. Влияет на видео и игры.", default: true },
  { id: "lifecycle", label: "Сигналы жизненного цикла", detail: "Дополнительно: pagehide, freeze/resume и возврат из кэша. Может мешать восстановлению страниц.", default: false },
  { id: "clipboard", label: "Скрывать копирование и вырезание", detail: "Дополнительно: события copy/cut. Вставка сохраняется; возможны проблемы с редакторами.", default: false },
  { id: "pointerBoundary", label: "Скрывать уход указателя", detail: "Дополнительно: события выхода без связанного элемента, в том числе на границе окна или фрейма.", default: false },
  { id: "viewport", label: "Скрывать изменение размера окна", detail: "Фиксирует основные размеры и ориентацию, фильтрует resize. Может мешать адаптивным интерфейсам; CSS и вёрстка остаются косвенным каналом.", default: true }
];
export const FEATURE_IDS = FEATURES.map(({ id }) => id);
export const DEFAULT_FEATURES = Object.fromEntries(FEATURES.map(({ id, default: value }) => [id, value]));

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

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function onlyKeys(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Неверный формат настроек.");
}
export function normalizeFeatures(value) {
  onlyKeys(value, FEATURE_IDS);
  if (FEATURE_IDS.some((key) => typeof value[key] !== "boolean")) throw new Error("Все переключатели защиты должны быть true или false.");
  return Object.fromEntries(FEATURE_IDS.map((key) => [key, value[key]]));
}
export function defaultSettings(allowlist = DEFAULT_ALLOWLIST) {
  return { schemaVersion: SETTINGS_SCHEMA, enabled: true, defaults: { ...DEFAULT_FEATURES }, allowlist: normalizeList(allowlist), sites: {} };
}
export function normalizeSettings(value) {
  onlyKeys(value, ["schemaVersion", "enabled", "defaults", "allowlist", "sites"]);
  if (value.schemaVersion === 2) {
    const legacyIds = FEATURE_IDS.filter((id) => id !== "viewport");
    const migrate = (flags) => {
      onlyKeys(flags, legacyIds);
      if (legacyIds.some((id) => typeof flags[id] !== "boolean")) throw new Error("Повреждён старый профиль защиты.");
      return { ...flags, viewport: legacyIds.some((id) => flags[id]) };
    };
    if (!record(value.sites)) throw new Error("Неверный формат профилей.");
    return normalizeSettings({ ...value, schemaVersion: SETTINGS_SCHEMA, defaults: migrate(value.defaults),
      sites: Object.fromEntries(Object.entries(value.sites).map(([host, flags]) => [host, migrate(flags)])) });
  }
  if (value.schemaVersion !== SETTINGS_SCHEMA || typeof value.enabled !== "boolean") throw new Error("Неподдерживаемая версия настроек.");
  if (!record(value.sites) || Object.keys(value.sites).length > 500) throw new Error("Допустимо до 500 профилей сайтов.");
  const entries = Object.entries(value.sites).map(([key, flags]) => [normalizeHost(key), normalizeFeatures(flags)]);
  if (new Set(entries.map(([host]) => host)).size !== entries.length) throw new Error("Повторяющиеся домены профилей.");
  return { schemaVersion: SETTINGS_SCHEMA, enabled: value.enabled, defaults: normalizeFeatures(value.defaults),
    allowlist: normalizeList(value.allowlist), sites: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}
export function effectiveFeatures(settings, host) {
  if (!settings.enabled || matchingRule(host, settings.allowlist)) return Object.fromEntries(FEATURE_IDS.map((id) => [id, false]));
  return { ...(Object.hasOwn(settings.sites, host) ? settings.sites[host] : settings.defaults) };
}
export function featureMask(flags) {
  return FEATURE_IDS.reduce((mask, id, index) => mask | (flags[id] ? 1 << index : 0), 0);
}
export function registrationGroups(settings) {
  if (!settings.enabled) return [];
  const defaultMask = featureMask(settings.defaults);
  const exclusions = excludePatterns(settings.allowlist);
  const overrides = Object.entries(settings.sites).filter(([host, flags]) => !matchingRule(host, settings.allowlist) && featureMask(flags) !== defaultMask);
  const groups = new Map();
  if (defaultMask) groups.set(defaultMask, {
    mask: defaultMask, matches: ["http://*/*", "https://*/*"],
    excludeMatches: [...exclusions, ...overrides.map(([host]) => `*://${host}/*`)]
  });
  for (const [host, flags] of overrides) {
    const mask = featureMask(flags);
    if (!mask) continue;
    if (!groups.has(mask)) groups.set(mask, { mask, matches: [], excludeMatches: exclusions });
    groups.get(mask).matches.push(`*://${host}/*`);
  }
  return [...groups.values()].sort((a, b) => a.mask - b.mask).map((group) => ({ ...group,
    features: FEATURE_IDS.filter((id, index) => (group.mask & (1 << index)) !== 0) }));
}
export function exportSettings(settings) {
  return JSON.stringify({ format: "activity-shield-settings", formatVersion: 1, settings: normalizeSettings(settings) }, null, 2);
}
export function parseSettingsImport(text) {
  if (typeof text !== "string" || text.length > MAX_BACKUP_SIZE) throw new Error("Файл настроек слишком большой (максимум 1 МБ).");
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Файл должен содержать корректный JSON."); }
  onlyKeys(value, ["format", "formatVersion", "settings"]);
  if (value.format !== "activity-shield-settings" || value.formatVersion !== 1) throw new Error("Это не поддерживаемая резервная копия Activity Shield.");
  return normalizeSettings(value.settings);
}
