import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = JSON.parse(await readFile(path.join(root, "extension/manifest.json"), "utf8"));
for (const browser of ["chromium", "firefox", "firefox-android"]) {
  const target = path.join(root, "dist", browser);
  await mkdir(target, { recursive: true });
  for (const file of ["shield.js", "popup.html", "popup.css", "popup.js", "settings.js", "background.js"]) {
    await cp(path.join(root, "extension", file), path.join(target, file));
  }
  const manifest = structuredClone(base);
  if (browser === "chromium") {
    manifest.minimum_chrome_version = "119";
    manifest.background = { service_worker: "background.js", type: "module" };
  }
  else manifest.browser_specific_settings = {
    gecko: {
      id: "activity-shield@antiprotection.local",
      strict_min_version: "128.0",
      data_collection_permissions: { required: ["none"] }
    }
  };
  if (browser !== "chromium") {
    manifest.background = { scripts: ["background.js"], type: "module" };
    manifest.browser_specific_settings.gecko_android = { strict_min_version: "142.0" };
  }
  if (browser === "firefox-android") {
    manifest.name = "Activity Shield Android — учебный проект";
    manifest.description = "Приватность в Firefox Android: скрытие прямых сигналов активности, белый список и синтетический полный экран.";
    manifest.browser_specific_settings.gecko.id = "activity-shield-android@antiprotection.local";
    manifest.browser_specific_settings.gecko.strict_min_version = "140.0";
    manifest.browser_specific_settings.gecko_android = { strict_min_version: "142.0" };
  }
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Built dist/${browser}`);
}
