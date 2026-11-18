import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { FEATURE_IDS } from "../extension/settings.js";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root));
const pkg = JSON.parse(await read("package.json"));
const lock = JSON.parse(await read("package-lock.json"));
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
if (process.env.GITHUB_REF_TYPE === "tag") assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, "Tag must match package version");
for (const target of ["chromium", "firefox", "firefox-android"]) {
  const zip = unzipSync(await read(`dist/activity-shield-${target}.zip`));
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]));
  assert.equal(manifest.version, pkg.version);
  assert.ok(strFromU8(zip["popup.html"]).includes(pkg.version), "Popup must show the packaged version");
  assert.equal(manifest.manifest_version, 3);
  assert.ok(!manifest.update_url && !manifest.browser_specific_settings?.gecko.update_url);
  if (target === "firefox") assert.equal(manifest.browser_specific_settings.gecko.id, "activity-shield@antiprotection.local");
  for (const file of ["background.js", "popup.html", "popup.js", "settings.js", "diagnostics.js", "audit/base.js",
    ...FEATURE_IDS.flatMap((id) => [`protections/${id}.js`, `audit/${id}.js`])]) assert.ok(zip[file]?.length, `Missing ${target}/${file}`);
}
const source = unzipSync(await read("dist/activity-shield-source.zip"));
assert.ok(source[".github/workflows/ci.yml"]);
assert.ok(source["tests/control-plane.mjs"]);
assert.ok(source["CHANGELOG.md"]);
assert.ok(!Object.keys(source).some((name) => /^(node_modules|\.env|\.android-test|test-results|dist)\//.test(name)));
const names = ["activity-shield-chromium.zip", "activity-shield-firefox.zip", "activity-shield-source.zip", "submission.zip"];
const checksums = [];
for (const name of names) checksums.push(`${createHash("sha256").update(await read(`dist/${name}`)).digest("hex")}  ${name}`);
await writeFile(new URL("dist/SHA256SUMS.txt", root), checksums.join("\n") + "\n");
const changelog = (await read("CHANGELOG.md")).toString("utf8").replace(/\r\n/g, "\n");
const heading = `## ${pkg.version}\n`;
assert.ok(changelog.includes(heading), "Add release notes to CHANGELOG.md first");
const entry = changelog.split(heading)[1].split("\n## ")[0].trim();
await writeFile(new URL("dist/RELEASE_NOTES.md", root), `# Activity Shield ${pkg.version}\n\n${entry}\n\nFirefox: [установить из Mozilla Add-ons](https://addons.mozilla.org/ru/firefox/addon/activity-shield-%D1%83%D1%87%D0%B5%D0%B1%D0%BD%D1%8B%D0%B9-%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82/). Версии в Mozilla и GitHub могут различаться: публикация обновления в AMO выполняется отдельно.\n\nChromium: распакуйте ZIP, загрузите папку в режиме разработчика. Обновление из GitHub выполняется вручную. Firefox ZIP здесь не подписан Mozilla и предназначен для разработки/отправки в AMO.\n\nПосле обновления расширения перезагрузите сайты. SHA256SUMS.txt содержит контрольные суммы приложенных архивов.\n`);
console.log(`Verified ${pkg.version}; checksums and release notes: ${fileURLToPath(new URL("dist/", root))}`);
