import { FEATURE_IDS } from "./settings.js";

// Pick explicit fields only. No URLs, hostnames, page contents, selection,
// browsing history, clipboard contents or raw exception messages are exported.
export function diagnosticReport({ version, browser, settings, status }) {
  const flags = (value) => Object.fromEntries(FEATURE_IDS.map((id) => [id, Boolean(value?.[id])]));
  return {
    format: "activity-shield-diagnostics", formatVersion: 1,
    extensionVersion: version, browser: { name: browser.name, version: browser.version },
    settings: { enabled: settings.enabled, defaults: flags(settings.defaults),
      allowlistCount: settings.allowlist.length, siteProfileCount: Object.keys(settings.sites).length },
    page: { state: status.state, reloadRequired: Boolean(status.reloadRequired),
      permissionGranted: Boolean(status.granted), loadedVersion: status.loadedVersion || null,
      wanted: flags(status.wanted), applied: flags(status.applied),
      verification: "isolated-load-record-and-main-api-probes; not a tamper-proof attestation" }
  };
}
