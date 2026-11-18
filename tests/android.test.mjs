import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmd } from "web-ext";
import { androidTarget } from "../scripts/android-target.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const serial = process.env.ANDROID_SERIAL;
const adb = process.env.ADB_BINARY || "adb";
const apk = process.env.FIREFOX_ANDROID_PACKAGE || "org.mozilla.firefox";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(200);
  }
  throw new Error(message);
}

// Use a normal visible Firefox tab and real Android input, not WebDriver's
// unbound Gecko sessions (which can have a 0x0 viewport in Fenix). The ordinary
// test page reports only the values available to page JS over loopback HTTP.
test("Firefox Android: installed extension, native input, long press, fullscreen and app background", {
  timeout: 240_000, skip: !serial && "Set ANDROID_SERIAL to a prepared Android test device"
}, async (t) => {
  await mkdir(path.join(root, "test-results"), { recursive: true });
  const run = (...args) => execFileSync(adb, ["-s", serial, ...args], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const reports = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/report" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try { const data = JSON.parse(body); reports.set(data.mode, data); res.writeHead(204).end(); }
      catch { res.writeHead(400).end(); }
      return;
    }
    const file = url.pathname === "/" ? "android-probe.html" : url.pathname === "/probe.js" ? "android-probe.js" : null;
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      "Content-Type": file.endsWith("html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
      "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; object-src 'none'"
    });
    res.end(await readFile(path.join(root, "tests/fixtures", file)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  run("reverse", `tcp:${port}`, `tcp:${port}`);
  let extensionRunner;
  t.after(async () => {
    await writeFile(path.join(root, "test-results/android-last-reports.json"), JSON.stringify(Object.fromEntries(reports), null, 2) + "\n");
    try {
      run("shell", "screencap", "-p", "/sdcard/activity-shield-last-screen.png");
      run("pull", "/sdcard/activity-shield-last-screen.png", path.join(root, "test-results/android-last-screen.png"));
    } catch (error) { console.log(`Diagnostic screenshot unavailable: ${error.message.split("\n")[0]}`); }
    try { if (extensionRunner) await extensionRunner.exit(); }
    finally {
      try { run("reverse", "--remove", `tcp:${port}`); } catch { /* Device may have disconnected. */ }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function bounds(text) {
    return until(async () => {
      try {
        const dump = run("shell", "uiautomator", "dump", "/sdcard/activity-shield-ui.xml");
        if (!dump.includes("dumped to:")) return null; // Never read a stale tree after a failed dump.
        const xml = run("shell", "cat", "/sdcard/activity-shield-ui.xml");
        const nodes = xml.match(/<node\b[^>]*>/g) || [];
        const node = nodes.find((entry) => entry.includes(`text="${text}"`) || entry.includes(`content-desc="${text}"`));
        // Android shows this one-time system tutorial after the control's
        // first genuine fullscreen request; it obscures the next tap target.
        if (xml.includes('text="Viewing full screen"')) {
          const acknowledgement = nodes.find((entry) => entry.includes('text="Got it"'));
          const position = acknowledgement?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (position) {
            run("shell", "input", "tap", String(Math.round((+position[1] + +position[3]) / 2)), String(Math.round((+position[2] + +position[4]) / 2)));
            return null;
          }
        }
        // Fenix can show a native confirmation after temporary installation.
        // Dismiss only the acknowledgement naming this extension.
        if (xml.includes("Activity Shield Android")) {
          const acknowledgement = nodes.find((entry) => entry.includes('text="OK"') || entry.includes('text="ОК"'));
          const position = acknowledgement?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (position) {
            run("shell", "input", "tap", String(Math.round((+position[1] + +position[3]) / 2)), String(Math.round((+position[2] + +position[4]) / 2)));
            return null;
          }
        }
        const match = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        return match && { x: Math.round((+match[1] + +match[3]) / 2), y: Math.round((+match[2] + +match[4]) / 2) };
      } catch { return null; }
    }, `Visible Android UI element not found: ${text}`, 15_000);
  }
  const manifest = JSON.parse(await readFile(path.join(root, "dist/firefox-android/manifest.json"), "utf8"));
  const results = { extensionVersion: manifest.version, android: run("shell", "getprop", "ro.build.version.release").trim(), checks: [] };
  const launcher = androidTarget({ adbBin: adb, device: serial, firefoxApk: apk });
  for (const protectedMode of [false, true]) {
    const mode = protectedMode ? "protected" : "baseline";
    if (protectedMode) extensionRunner = await cmd.run({
      target: ["firefox-android"], sourceDir: path.join(root, "dist/firefox-android"),
      artifactsDir: path.join(root, "test-results"), adbBin: adb, adbDevice: serial,
      firefoxApk: apk, firefoxApkComponent: launcher.component,
      noReload: true, noInput: true, adbDiscoveryTimeout: 30_000
    });
    run("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `http://127.0.0.1:${port}/?mode=${mode}`, "-p", apk);
    const initial = await until(() => reports.get(mode)?.viewport.width > 0 && reports.get(mode)?.viewport.height > 0 && reports.get(mode), `No visible page report for ${mode}`);
    assert.ok(initial.viewport.width > 0 && initial.viewport.height > 0, "Test uses a visible browser tab");
    if (protectedMode) {
      assert.deepEqual(initial.initial, { hidden: false, visibilityState: "visible", hasFocus: true });
      assert.deepEqual(initial.selection, { text: "", count: 0, start: 0, end: 0 });
    } else {
      assert.ok(initial.selection.text.length > 10);
      assert.equal(initial.selection.count, 1);
      assert.equal(initial.selection.start, 2);
      assert.equal(initial.selection.end, 7);
    }
    const button = await bounds("Test tap");
    run("shell", "input", "tap", String(button.x), String(button.y));
    await until(() => reports.get(mode)?.clicks > 0, "Real Android tap did not reach button");
    const input = await bounds("testing");
    run("shell", "input", "tap", String(input.x), String(input.y));
    await until(() => reports.get(mode)?.activeElement === "input", "Input did not receive real focus");
    await until(() => /mInputShown=true|mIsInputViewShown=true/.test(run("shell", "dumpsys", "input_method")), "Android keyboard did not become ready");
    run("shell", "input", "keyevent", "KEYCODE_MOVE_END");
    run("shell", "input", "text", "z");
    await until(() => reports.get(mode)?.input === "testingz", "Native input did not work");
    run("shell", "input", "keyevent", "KEYCODE_BACK");
    const link = await bounds("Long press link");
    run("shell", "input", "swipe", String(link.x), String(link.y), String(link.x), String(link.y), "1200");
    await delay(400);
    run("shell", "input", "keyevent", "KEYCODE_BACK");
    const sequence = reports.get(mode).sequence;
    const afterLongPress = await until(() => reports.get(mode)?.sequence > sequence && reports.get(mode), "Page did not resume after context menu");
    assert.equal(afterLongPress.contextmenu > 0, !protectedMode, "Native long-press contextmenu is filtered");

    const fullscreenButton = await bounds("Start fullscreen");
    run("shell", "input", "tap", String(fullscreenButton.x), String(fullscreenButton.y));
    const fullscreen = await until(() => reports.get(mode)?.fullscreen.request === "resolved"
      && reports.get(mode)?.fullscreen.history.length > 0 && reports.get(mode).fullscreen,
      "Native tap did not resolve fullscreen and deliver its change event");
    assert.equal(fullscreen.active, true);
    assert.equal(fullscreen.css, !protectedMode, "Only the control enters actual Android fullscreen");
    assert.deepEqual(fullscreen.history, [{ active: true, trusted: !protectedMode }]);

    // Reproduce the manual report: the last focused control is a button.
    const homeButton = await bounds("Test tap");
    const previousClicks = reports.get(mode).clicks;
    run("shell", "input", "tap", String(homeButton.x), String(homeButton.y));
    const beforeHome = await until(() => reports.get(mode)?.clicks > previousClicks && reports.get(mode)?.activeElement === "button" && reports.get(mode), "Button did not get normal focus before Home");
    assert.ok(beforeHome.focusHistory.includes("focus:input"), "Normal input focus is preserved");
    assert.ok(beforeHome.focusHistory.includes("blur:input"), "Normal input blur is preserved");
    const focusCount = beforeHome.focusHistory.length;

    // Open a real opaque app and verify it is foreground. The emulator's
    // launcher can remain translucent during a cold System UI transition,
    // keeping a native-fullscreen control page visible behind the launcher.
    run("shell", "am", "start", "-W", "-a", "android.settings.SETTINGS");
    await until(() => {
      const activity = run("shell", "dumpsys", "activity", "activities").split("\n")
        .find((line) => /topResumedActivity=|mResumedActivity[:=]/.test(line));
      return activity && !activity.includes(`${apk}/`);
    }, "Android did not actually move Firefox out of foreground");
    await delay(1500);
    run("shell", "monkey", "-p", apk, "-c", "android.intent.category.LAUNCHER", "1");
    const sequenceBeforeResume = reports.get(mode).sequence;
    const resumed = await until(() => reports.get(mode)?.sequence > sequenceBeforeResume && reports.get(mode), "Firefox tab did not resume");
    if (protectedMode) {
      assert.deepEqual(resumed.visibilityHistory, []);
      assert.deepEqual(resumed.focusHistory.slice(focusCount), [], "No element or window focus leak across Home/return");
      assert.deepEqual(resumed.current, { hidden: false, visibilityState: "visible", hasFocus: true });
      assert.equal(resumed.fullscreen.active, true, "Synthetic fullscreen survives Android Home/return");
      assert.deepEqual(resumed.fullscreen.history, fullscreen.history, "No fullscreen event leaks across app changes");
    } else assert.ok(resumed.visibilityHistory.includes(true), "Control tab observed real Android background transition");
    results.checks.push({ mode, initial, beforeHome, resumed });
    console.log(`Android ${results.android}, ${resumed.userAgent}: ${mode} passed`);
    if (protectedMode) {
      // JS can report immediately after app resume, before Android composites
      // the page. Wait for its visible accessibility tree before the proof.
      await bounds("Test tap");
      await delay(300);
      run("shell", "screencap", "-p", "/sdcard/activity-shield-proof.png");
      run("pull", "/sdcard/activity-shield-proof.png", path.join(root, "test-results/firefox-android.png"));
    }
  }
  await writeFile(path.join(root, "test-results/android.json"), JSON.stringify(results, null, 2) + "\n");
});
