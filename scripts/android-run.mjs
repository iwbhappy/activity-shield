import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidTarget } from "./android-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const argv = process.argv.slice(2);
function take(names) {
  let value;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const name = names.find((candidate) => argument === candidate || argument.startsWith(candidate + "="));
    if (!name) continue;
    if (argument === name) {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Не задано значение ${name}`);
      value = argv[index + 1];
      argv.splice(index, 2);
    } else { value = argument.slice(name.length + 1); argv.splice(index, 1); }
    index--;
  }
  return value;
}

try {
  const sdkAdb = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android/Sdk/platform-tools/adb.exe");
  const adbBin = take(["--adb-bin"]) || process.env.WEB_EXT_ADB_BIN || process.env.ADB_BINARY || (sdkAdb && existsSync(sdkAdb) ? sdkAdb : "adb");
  const device = take(["--adb-device", "--android-device"]) || process.env.WEB_EXT_ADB_DEVICE || process.env.ANDROID_SERIAL;
  const firefoxApk = take(["--firefox-apk"]) || process.env.FIREFOX_ANDROID_PACKAGE || "org.mozilla.firefox";
  const override = take(["--firefox-apk-component"]);
  const target = androidTarget({ adbBin, device, firefoxApk });
  if (override) target.component = override;
  console.log(`Android device: ${target.device}`);
  console.log(`Firefox launcher: ${target.firefoxApk}/${target.component}`);
  if (argv.includes("--dry-run")) {
    console.log("Проверено подключение и определён компонент; Firefox не запускался, расширение не устанавливалось.");
  } else {
    const child = spawn(process.execPath, [path.join(root, "node_modules/web-ext/bin/web-ext.js"), "run",
      "--source-dir", path.join(root, "dist/firefox-android"), "--target", "firefox-android",
      "--adb-bin", adbBin, "--adb-device", target.device, "--firefox-apk", target.firefoxApk,
      "--firefox-apk-component", target.component, ...argv], { stdio: "inherit", windowsHide: true });
    child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
    child.on("exit", (code) => { process.exitCode = code ?? 1; });
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
