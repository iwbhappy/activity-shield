import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
async function collect(relative, files = {}) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await collect(name, files);
    else if (entry.isFile()) files[name] = await readFile(path.join(root, name));
  }
  return files;
}

for (const browser of ["chromium", "firefox", "firefox-android"]) {
  const prefix = `dist/${browser}/`;
  const entries = await collect(`dist/${browser}`);
  const flat = Object.fromEntries(Object.entries(entries).map(([name, data]) => [name.slice(prefix.length), data]));
  const name = `dist/activity-shield-${browser}.zip`;
  await writeFile(path.join(root, name), zipSync(flat));
  if (browser === "firefox-android") {
    await writeFile(path.join(root, "dist/activity-shield-firefox-android-unsigned.xpi"), zipSync(flat));
  }
  console.log(`Packed ${name}`);
}

const submission = {};
for (const directory of ["extension", "android", "scripts", "tests", "demo", "dist/chromium", "dist/firefox", "dist/firefox-android"]) {
  await collect(directory, submission);
}
for (const file of [
  "README.md", "REPORT.md", "ANDROID.md", "PUBLISHING.md", "GITHUB.md", "package.json", "package-lock.json", ".gitignore",
  "dist/activity-shield-chromium.zip", "dist/activity-shield-firefox.zip",
  "dist/activity-shield-firefox-android.zip", "dist/activity-shield-firefox-android-unsigned.xpi"
]) submission[file] = await readFile(path.join(root, file));
const source = Object.fromEntries(Object.entries(submission).filter(([name]) => !name.startsWith("dist/")));
await writeFile(path.join(root, "dist/activity-shield-source.zip"), zipSync(source));
console.log("Packed dist/activity-shield-source.zip (repository sources without build outputs)");
await writeFile(path.join(root, "dist/submission.zip"), zipSync(submission));
console.log("Packed dist/submission.zip (source, reports, demo, tests and all extensions)");
const androidSubmission = Object.fromEntries(Object.entries(submission).filter(([name]) =>
  !name.startsWith("dist/chromium/") && !name.startsWith("dist/firefox/") &&
  !["dist/activity-shield-chromium.zip", "dist/activity-shield-firefox.zip"].includes(name)
));
await writeFile(path.join(root, "dist/submission-android.zip"), zipSync(androidSubmission));
console.log("Packed dist/submission-android.zip (Android source, reports, demo, tests and unsigned XPI)");
