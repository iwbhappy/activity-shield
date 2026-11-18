import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { Builder, By, Key } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { startDemo } from "../scripts/serve-demo.mjs";
import { verifyControlPlane } from "./control-plane.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

async function firefoxPopupURL(driver, id) {
  await driver.setContext("chrome");
  try {
    const uuid = await driver.executeScript("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))[arguments[0]]", id);
    assert.ok(uuid, "Firefox assigned this installed extension a UUID");
    return `moz-extension://${uuid}/popup.html`;
  } finally { await driver.setContext("content"); }
}

async function createEditorProbe(read) {
  await read(() => {
    const editor = document.createElement("div");
    editor.id = "editor-probe";
    editor.contentEditable = "true";
    editor.style.cssText = "min-height:60px;border:1px solid;padding:12px";
    // A real selection-aware editor: typing requires a usable selection.
    editor.addEventListener("beforeinput", (event) => {
      if (!getSelection().rangeCount) event.preventDefault();
    });
    document.body.append(editor);
  });
}

async function verifyFullscreen(read, clickStart, escape, switchTabs, protectedMode) {
  const before = await read(() => {
    window.fullscreenProbe = [];
    document.addEventListener("fullscreenchange", (event) => {
      window.fullscreenProbe.push({ trusted: event.isTrusted, active: Boolean(document.fullscreenElement) });
    });
    return { active: document.fullscreenElement !== null, width: innerWidth, height: innerHeight };
  });
  assert.equal(before.active, false, "A fresh page does not claim fullscreen before a request");
  await clickStart(); // Real user activation, also required by the unprotected control.
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const result = await read(predicate);
      if (result) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(label);
  };
  await waitFor(() => window.demo.fullscreenRequest === "resolved" && window.fullscreenProbe.length > 0,
    "Fullscreen request resolves and its change event reaches the page");
  const entered = await read(() => ({
    element: document.fullscreenElement === document.documentElement,
    aliases: ["webkitFullscreenElement", "webkitCurrentFullScreenElement", "mozFullScreenElement"]
      .filter((name) => name in document).map((name) => ({ name, active: document[name] === document.documentElement })),
    legacy: "fullscreen" in document ? document.fullscreen : null,
    css: document.documentElement.matches(":fullscreen"),
    width: innerWidth, height: innerHeight,
    events: window.fullscreenProbe.slice(),
    permitted: document.getElementById("fullscreen-status").textContent.includes("разрешает продолжить")
  }));
  assert.equal(entered.element, true);
  assert.ok(entered.aliases.every((entry) => entry.active), "Available legacy element getters agree with the standard API");
  assert.equal(entered.permitted, true, "An ordinary page's fullscreen gate accepts the state");
  if (entered.legacy !== null) assert.equal(entered.legacy, true);
  assert.equal(entered.css, !protectedMode, "Protection never activates native CSS fullscreen");
  assert.deepEqual(entered.events, [{ trusted: !protectedMode, active: true }]);
  if (protectedMode) {
    assert.equal(entered.width, before.width);
    assert.equal(entered.height, before.height);
    await escape();
    await switchTabs();
    const returned = await read(() => ({
      element: document.fullscreenElement === document.documentElement,
      events: window.fullscreenProbe.slice()
    }));
    assert.equal(returned.element, true, "Esc and tab changes do not clear synthetic fullscreen");
    assert.deepEqual(returned.events, entered.events, "No fullscreen transition leaks after Esc/tab switch");
    const filtered = await read(() => {
      const before = window.fullscreenProbe.length;
      let errors = 0;
      const onError = () => { errors++; };
      document.addEventListener("fullscreenerror", onError);
      document.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
      document.dispatchEvent(new Event("fullscreenerror", { bubbles: true }));
      document.removeEventListener("fullscreenerror", onError);
      return window.fullscreenProbe.length === before && errors === 0;
    });
    assert.equal(filtered, true, "Only extension-generated fullscreen events pass the filter");
  }
  await read(async () => { await document.exitFullscreen(); });
  await waitFor(() => !document.fullscreenElement && window.fullscreenProbe.length === 2,
    "An explicit page exit clears state and sends a change event");
  const exited = await read(() => window.fullscreenProbe.slice());
  assert.deepEqual(exited[1], { trusted: !protectedMode, active: false });
  if (protectedMode) {
    const extra = await read(async () => {
      const detached = document.createElement("div");
      let invalid, noFullscreen;
      try { await detached.requestFullscreen(); } catch (error) { invalid = error.name; }
      try { await document.exitFullscreen(); } catch (error) { noFullscreen = error.name; }
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      const child = document.createElement("div");
      shadow.append(child);
      await child.requestFullscreen();
      const retargeted = document.fullscreenElement === host && shadow.fullscreenElement === child;
      await document.exitFullscreen();
      host.remove();
      const legacy = [];
      for (const [request, exit] of [["webkitRequestFullscreen", "webkitExitFullscreen"],
        ["webkitRequestFullScreen", "webkitCancelFullScreen"], ["mozRequestFullScreen", "mozCancelFullScreen"]]) {
        if (!document.documentElement[request] || !document[exit]) continue;
        const value = document.documentElement[request]();
        const active = document.fullscreenElement === document.documentElement;
        document[exit]();
        legacy.push(value === undefined && active && document.fullscreenElement === null);
      }
      return { invalid, noFullscreen, retargeted, legacy: legacy.every(Boolean) };
    });
    assert.deepEqual(extra, { invalid: "TypeError", noFullscreen: "TypeError", retargeted: true, legacy: true });
  }
  return { protectedMode, before, entered, exited };
}

// The same page-side probes run in real Chromium and Firefox with the actual
// extension installed. No addInitScript/evaluate(shield) substitute is used.
async function verify(read, protectedMode) {
  const initial = await read(() => window.demo.initial);
  assert.equal(initial.visibilityState, "visible");
  if (protectedMode) {
    assert.equal(initial.hidden, false);
    assert.equal(initial.hasFocus, true);
  }

  const selected = await read(() => {
    const selection = getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("sample-text"));
    selection.addRange(range);
    let error = null;
    try { selection.getRangeAt(0); } catch (e) { error = e.name; }
    return {
      text: String(selection), documentText: String(document.getSelection()),
      count: selection.rangeCount, anchor: selection.anchorNode !== null,
      contains: selection.containsNode(document.getElementById("sample-text"), true),
      collapsed: selection.isCollapsed, type: selection.type, error,
      isSelection: selection instanceof Selection,
      composed: selection.getComposedRanges?.().length ?? null
    };
  });
  assert.equal(selected.isSelection, true);
  if (protectedMode) {
    assert.equal(selected.text, "");
    assert.equal(selected.documentText, "");
    assert.equal(selected.count, 0);
    assert.equal(selected.anchor, false);
    assert.equal(selected.contains, false);
    assert.equal(selected.collapsed, true);
    assert.equal(selected.type, "None");
    assert.equal(selected.error, "IndexSizeError");
    if (selected.composed !== null) assert.equal(selected.composed, 0);
  } else {
    assert.ok(selected.text.length > 10);
    assert.ok(selected.count > 0);
    assert.equal(selected.anchor, true);
    assert.equal(selected.error, null);
  }

  const fields = await read(() => {
    return ["text-input", "text-area", "number-input"].map((id) => {
      const field = document.getElementById(id);
      if (id !== "number-input") {
        field.setSelectionRange(2, 7, "forward");
        field.selectionStart = 1; // Native setters must still accept writes.
      }
      return [field.selectionStart, field.selectionEnd, field.selectionDirection];
    });
  });
  assert.deepEqual(fields[0], protectedMode ? [0, 0, "none"] : [1, 7, "forward"]);
  assert.deepEqual(fields[1], protectedMode ? [0, 0, "none"] : [1, 7, "forward"]);
  assert.deepEqual(fields[2], [null, null, null]);

  const dispatch = await read(() => {
    const target = document.getElementById("sample-text");
    let seen = 0;
    const count = () => { seen++; };
    const types = ["contextmenu", "selectionchange", "selectstart", "select", "visibilitychange", "webkitvisibilitychange"];
    for (const type of types) {
      window.addEventListener(type, count, true);
      document.addEventListener(type, count, true);
      target.addEventListener(type, count);
    }
    target.oncontextmenu = count;
    document.onselectionchange = count;
    const defaults = types.map((type) => target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })));
    for (const type of ["mousedown", "mouseup", "mousemove", "auxclick", "pointerdown", "pointerup", "pointermove"]) {
      target.addEventListener(type, count);
      const Constructor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      defaults.push(target.dispatchEvent(new Constructor(type, { button: 2, buttons: 2, bubbles: true, cancelable: true })));
    }
    for (const type of ["keydown", "keyup"]) {
      target.addEventListener(type, count);
      defaults.push(target.dispatchEvent(new KeyboardEvent(type, { key: "ContextMenu", bubbles: true, cancelable: true })));
      defaults.push(target.dispatchEvent(new KeyboardEvent(type, { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
    }
    let windowFocus = 0;
    const focusCounter = () => { windowFocus++; };
    for (const type of ["blur", "focus", "focusin", "focusout"]) {
      window.addEventListener(type, focusCounter, true);
      window.dispatchEvent(new FocusEvent(type));
      document.dispatchEvent(new FocusEvent(type));
    }
    let inputFocus = 0;
    const input = document.getElementById("text-input");
    input.addEventListener("focus", () => { inputFocus++; });
    input.focus();
    return { seen, windowFocus, inputFocus, defaults };
  });
  assert.ok(dispatch.defaults.every(Boolean), "Default browser actions are not cancelled");
  assert.equal(dispatch.inputFocus, 1, "Native form focus works");
  if (protectedMode) {
    assert.equal(dispatch.seen, 0, "Blocked events never reach page handlers");
    // Input focus may reach window capture; only window/document events are hidden.
    assert.ok(dispatch.windowFocus <= 2);
  } else {
    assert.ok(dispatch.seen > 10);
    assert.ok(dispatch.windowFocus >= 8);
  }

  const formFocus = await read(() => {
    const input = document.getElementById("text-input");
    const area = document.getElementById("text-area");
    input.focus();
    const observed = [];
    input.addEventListener("blur", () => observed.push("input blur"), { once: true });
    area.addEventListener("focus", () => observed.push("area focus"), { once: true });
    area.focus();
    return observed;
  });
  assert.deepEqual(formFocus, ["input blur", "area focus"], "Real focus changes between fields remain available");
}

async function probeFrames(read, url) {
  await read((base) => {
    for (const [id, src] of [["same", `${base}/frame.html`], ["cross", `${base.replace("127.0.0.1", "localhost")}/frame.html`]]) {
      const frame = document.createElement("iframe");
      frame.id = id;
      frame.src = src;
      document.body.append(frame);
    }
  }, url);
}

test("Chromium: installed extension and unprotected control", { timeout: 120_000 }, async (t) => {
  const server = await startDemo();
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const protectedMode of [false, true]) {
    await t.test(protectedMode ? "protected" : "baseline", async () => {
      const extension = path.join(root, "dist/chromium");
      const context = await chromium.launchPersistentContext("", {
        headless: true,
        ...(process.env.CHROMIUM_BINARY ? { executablePath: process.env.CHROMIUM_BINARY } : { channel: "chromium" }),
        args: protectedMode ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : []
      });
      try {
        const page = await context.newPage();
        let popupURL;
        if (protectedMode) {
          const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
          popupURL = new URL("popup.html", worker.url()).href;
          // Installation initializes the persistent registration asynchronously.
          // Wait for its settings UI before the first tested navigation.
          await page.goto(popupURL);
          await page.getByRole("button", { name: "Удалить web.whatsapp.com", exact: true }).waitFor();
        }
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await verify((fn, arg) => page.evaluate(fn, arg), protectedMode);
        await page.reload();
        await page.locator("#sample-text").click({ button: "right" });
        const rightClicks = await page.evaluate(() => window.demo.counters["contextmenu:sample-text"] || 0);
        assert.equal(rightClicks > 0, !protectedMode, "Real right click is hidden only with extension");
        await page.keyboard.press("Escape");
        await page.locator("#ordinary-button").click();
        assert.equal(await page.locator("#ordinary-button").textContent(), "Обычная кнопка: 1");
        await page.locator("#text-input").fill("abc");
        await page.locator("#text-input").press("End");
        await page.keyboard.type("z");
        assert.equal(await page.locator("#text-input").inputValue(), "abcz");

        const fullscreen = await verifyFullscreen(
          (fn, arg) => page.evaluate(fn, arg),
          () => page.locator("#fullscreen-start").click(),
          () => page.keyboard.press("Escape"),
          async () => {
            const other = await context.newPage();
            await other.goto(`${url}/frame.html`);
            await page.bringToFront();
            await other.close();
          }, protectedMode
        );
        await mkdir(path.join(root, "test-results"), { recursive: true });
        await writeFile(path.join(root, `test-results/fullscreen-chromium-${protectedMode ? "protected" : "baseline"}.json`), JSON.stringify(fullscreen, null, 2));

        if (protectedMode) {
          await probeFrames((fn, arg) => page.evaluate(fn, arg), url);
          for (const id of ["same", "cross"]) {
            const frameElement = await page.locator(`#${id}`).elementHandle();
            const frame = await frameElement.contentFrame();
            await frame.waitForFunction(() => Boolean(window.demo));
            assert.deepEqual(await frame.evaluate(() => window.demo.initial), { hidden: false, visibilityState: "visible", hasFocus: true });
            assert.equal(await frame.evaluate(() => {
              getSelection().selectAllChildren(document.getElementById("sample-text"));
              return String(getSelection());
            }), "");
          }
          await mkdir(path.join(root, "test-results"), { recursive: true });
          await page.screenshot({ path: path.join(root, "test-results/chromium-protected.png"), fullPage: true });
          // Actual extension UI changes the browser's registration, with no
          // per-page script injection or mock storage in this test.
          await createEditorProbe((fn) => page.evaluate(fn));
          await page.locator("#editor-probe").click();
          await page.keyboard.type("hello");
          assert.equal(await page.locator("#editor-probe").textContent(), "");
          await page.goto(popupURL);
          await page.locator("#domain").fill("127.0.0.1");
          await page.locator('button[type="submit"]').click();
          await page.getByRole("button", { name: "Удалить 127.0.0.1", exact: true }).waitFor();
          await page.reload();
          await page.getByRole("button", { name: "Удалить 127.0.0.1", exact: true }).waitFor();
          await page.goto(url);
          await verify((fn, arg) => page.evaluate(fn, arg), false);
          await createEditorProbe((fn) => page.evaluate(fn));
          await page.locator("#editor-probe").click();
          await page.keyboard.type("hello");
          assert.equal(await page.locator("#editor-probe").textContent(), "hello", "Allowlisted editor accepts native typing");
          await page.goto(url.replace("127.0.0.1", "localhost"));
          assert.equal(await page.evaluate(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); }), "", "Unlisted host remains protected");
          await page.goto(popupURL);
          await page.getByRole("button", { name: "Удалить 127.0.0.1", exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('[aria-label="Удалить 127.0.0.1"]'));
          await page.goto(url);
          await verify((fn, arg) => page.evaluate(fn, arg), true);
          const control = await context.newPage();
          await control.goto(popupURL);
          await control.locator("#pause-protection:not([disabled])").waitFor();
          try {
            const tabId = await control.evaluate(async (address) => (await chrome.tabs.query({})).find((tab) => tab.url === address + "/").id, url);
            await verifyControlPlane({
              extensionRead: (fn, arg) => control.evaluate(fn, arg), pageRead: (fn, arg) => page.evaluate(fn, arg),
              navigate: (address) => page.goto(address), tabId, url,
              startFullscreen: async () => {
                await page.bringToFront();
                await page.locator("#fullscreen-start").click();
                await page.waitForFunction(() => window.demo.fullscreenRequest === "resolved");
              },
              exportUI: async () => {
                await control.evaluate(() => { document.getElementById("export-settings").closest("details").open = true; });
                const pending = control.waitForEvent("download");
                await control.locator("#export-settings").click();
                const download = await pending;
                const destination = path.join(root, "test-results/chromium-settings.json");
                await download.saveAs(destination);
                return readFile(destination, "utf8");
              },
              importUI: async (text, valid) => {
                await control.evaluate(() => { document.getElementById("import-file").closest("details").open = true; });
                await control.locator("#import-file").setInputFiles({ name: "settings.json", mimeType: "application/json", buffer: Buffer.from(text) });
                if (valid) {
                  await control.locator("#apply-import").click();
                  await control.locator("#apply-import").waitFor({ state: "hidden" });
                } else {
                  await control.waitForFunction(() => document.getElementById("import-preview").textContent.length > 0 && document.getElementById("apply-import").hidden);
                }
              }
            });
          } finally { await control.close(); }
        }
        assert.deepEqual(errors, [], "No page script errors under strict CSP");
        console.log(`Chromium ${context.browser().version()}: ${protectedMode ? "protected" : "baseline"} passed`);
      } finally { await context.close(); }
    });
  }
});

test("Firefox: installed extension, baseline and real background tab", { timeout: 180_000 }, async (t) => {
  process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1"; // This test's disposable browser profile only.
  const server = await startDemo();
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = new firefox.Options().addArguments("-headless", "--allow-system-access");
  await mkdir(path.join(root, "test-results"), { recursive: true });
  const downloads = await mkdtemp(path.join(root, "test-results/firefox-downloads-"));
  options.setPreference("browser.download.folderList", 2);
  options.setPreference("browser.download.dir", downloads);
  options.setPreference("browser.download.useDownloadDir", true);
  options.setPreference("browser.helperApps.neverAsk.saveToDisk", "application/json");
  if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
  const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
  try {
    await driver.manage().setTimeouts({ implicit: 0, pageLoad: 20_000, script: 10_000 });
    const read = (fn, arg) => driver.executeScript(`return (${fn.toString()})(arguments[0]);`, arg ?? null);
    for (const protectedMode of [false, true]) {
      let popupURL;
      if (protectedMode) {
        const id = await driver.installAddon(path.join(root, "dist/firefox"), true);
        popupURL = await firefoxPopupURL(driver, id);
        await driver.get(popupURL);
        try { await driver.wait(async () => (await driver.findElements(By.css('#allowlist li'))).length > 0, 10_000); }
        catch (error) { throw new Error(`Firefox settings failed to initialize: ${await driver.findElement(By.tagName("body")).getText()}`, { cause: error }); }
      }
      await driver.get(url);
      await verify(read, protectedMode);
      await driver.get(url);
      const sample = await driver.findElement(By.id("sample-text"));
      await read(() => document.getElementById("sample-text").scrollIntoView({ block: "center" }));
      await driver.actions().contextClick(sample).perform();
      const rightClicks = await read(() => window.demo.counters["contextmenu:sample-text"] || 0);
      assert.equal(rightClicks > 0, !protectedMode, "Real right click");
      await driver.actions().sendKeys(Key.ESCAPE).perform();
      await driver.findElement(By.id("ordinary-button")).click();
      assert.equal(await driver.findElement(By.id("ordinary-button")).getText(), "Обычная кнопка: 1");
      const input = await driver.findElement(By.id("text-input"));
      await input.clear();
      await input.sendKeys("abc", Key.END, "z");
      assert.equal(await input.getAttribute("value"), "abcz");

      const fullscreen = await verifyFullscreen(
        read,
        () => driver.findElement(By.id("fullscreen-start")).click(),
        () => driver.actions().sendKeys(Key.ESCAPE).perform(),
        async () => {
          const original = await driver.getWindowHandle();
          await driver.switchTo().newWindow("tab");
          await driver.get(`${url}/frame.html`);
          await driver.close();
          await driver.switchTo().window(original);
        }, protectedMode
      );
      await mkdir(path.join(root, "test-results"), { recursive: true });
      await writeFile(path.join(root, `test-results/fullscreen-firefox-${protectedMode ? "protected" : "baseline"}.json`), JSON.stringify(fullscreen, null, 2));

      // executeScript can query a non-selected window, so this checks real
      // browser visibility while another tab is selected (no synthetic event).
      const originalHandle = await driver.getWindowHandle();
      await driver.switchTo().newWindow("tab");
      const otherHandle = await driver.getWindowHandle();
      await driver.get(`${url}/frame.html`);
      await driver.switchTo().window(originalHandle);
      await read(() => {
        window.demo.backgroundSamples = [];
        window.demo.sampleTimer = setInterval(() => {
          window.demo.backgroundSamples.push({ hidden: document.hidden, focus: document.hasFocus() });
        }, 100);
      });
      await driver.switchTo().window(otherHandle);
      // Wait on observable samples, with timer throttling allowed, then return.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      await driver.switchTo().window(originalHandle);
      const samples = await read(() => {
        clearInterval(window.demo.sampleTimer);
        return window.demo.backgroundSamples;
      });
      assert.ok(samples.length > 0, "Background tab was sampled");
      if (protectedMode) {
        assert.ok(samples.every((s) => !s.hidden && s.focus));
        assert.equal(await read(() => window.demo.counters["visibilitychange:document"] || 0), 0);
      } else assert.ok(samples.some((s) => s.hidden), "Control tab really becomes hidden");

      if (protectedMode) {
        await probeFrames(read, url);
        for (const id of ["same", "cross"]) {
          const element = await driver.findElement(By.id(id));
          await driver.switchTo().frame(element);
          await driver.wait(async () => Boolean(await read(() => window.demo)), 10_000);
          assert.deepEqual(await read(() => window.demo.initial), { hidden: false, visibilityState: "visible", hasFocus: true });
          assert.equal(await read(() => {
            getSelection().selectAllChildren(document.getElementById("sample-text"));
            return String(getSelection());
          }), "");
          await driver.switchTo().defaultContent();
        }
        await createEditorProbe(read);
        await driver.findElement(By.id("editor-probe")).sendKeys("hello");
        assert.equal(await driver.findElement(By.id("editor-probe")).getText(), "");
        await driver.get(popupURL);
        await driver.findElement(By.id("domain")).sendKeys("127.0.0.1");
        await driver.findElement(By.css('button[type="submit"]')).click();
        await driver.wait(async () => (await driver.findElements(By.css('[aria-label="Удалить 127.0.0.1"]'))).length > 0, 10_000);
        await driver.navigate().refresh();
        await driver.wait(async () => (await driver.findElements(By.css('[aria-label="Удалить 127.0.0.1"]'))).length > 0, 10_000);
        await driver.get(url);
        await verify(read, false);
        await createEditorProbe(read);
        await driver.findElement(By.id("editor-probe")).sendKeys("hello");
        assert.equal(await driver.findElement(By.id("editor-probe")).getText(), "hello", "Allowlisted editor accepts native typing");
        await driver.get(url.replace("127.0.0.1", "localhost"));
        assert.equal(await read(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); }), "");
        await driver.get(popupURL);
        await driver.wait(async () => (await driver.findElements(By.css('[aria-label="Удалить 127.0.0.1"]'))).length > 0, 10_000);
        await driver.findElement(By.css('[aria-label="Удалить 127.0.0.1"]')).click();
        await driver.wait(async () => (await driver.findElements(By.css('[aria-label="Удалить 127.0.0.1"]'))).length === 0, 10_000);
        await driver.get(url);
        await verify(read, true);
        await driver.switchTo().newWindow("tab");
        const controlHandle = await driver.getWindowHandle();
        await driver.get(popupURL);
        await driver.wait(async () => (await driver.findElement(By.id("pause-protection"))).isEnabled(), 10_000);
        const extensionRead = async (fn, arg) => { await driver.switchTo().window(controlHandle); return read(fn, arg); };
        const pageRead = async (fn, arg) => { await driver.switchTo().window(originalHandle); return read(fn, arg); };
        try {
          const tabId = await extensionRead(async (address) => (await browser.tabs.query({})).find((tab) => tab.url === address + "/").id, url);
          await verifyControlPlane({
            extensionRead, pageRead, tabId, url,
            navigate: async (address) => { await driver.switchTo().window(originalHandle); await driver.get(address); },
            startFullscreen: async () => {
              await driver.switchTo().window(originalHandle);
              await driver.findElement(By.id("fullscreen-start")).click();
              await driver.wait(() => read(() => window.demo.fullscreenRequest === "resolved"), 8000);
            },
            exportUI: async () => {
              await extensionRead(() => { document.getElementById("export-settings").closest("details").open = true; });
              await driver.findElement(By.id("export-settings")).click();
              let contents;
              await driver.wait(async () => {
                try { contents = await readFile(path.join(downloads, "activity-shield-settings.json"), "utf8"); return Boolean(contents); }
                catch { return false; }
              }, 10_000);
              return contents;
            },
            importUI: async (text, valid) => {
              const destination = path.join(downloads, valid ? "import-valid.json" : "import-invalid.json");
              await writeFile(destination, text);
              await extensionRead(() => { document.getElementById("import-file").closest("details").open = true; });
              await driver.findElement(By.id("import-file")).sendKeys(destination);
              try {
              if (valid) {
                await driver.wait(async () => (await driver.findElement(By.id("apply-import"))).isDisplayed(), 10_000);
                await driver.findElement(By.id("apply-import")).click();
                await driver.wait(async () => !(await (await driver.findElement(By.id("apply-import"))).isDisplayed()), 10_000);
              } else {
                await driver.wait(() => read(() => document.getElementById("import-preview").textContent.length > 0 && document.getElementById("apply-import").hidden), 10_000);
              }
              } catch (error) {
                throw new Error(`Firefox import (${valid ? "valid" : "invalid"}): ${await read(() => document.getElementById("import-preview").textContent + " / " + document.getElementById("message").textContent)}`, { cause: error });
              }
            }
          });
        } finally {
          await driver.switchTo().window(controlHandle); await driver.close();
          await driver.switchTo().window(originalHandle);
        }
      }
      await driver.switchTo().window(otherHandle);
      await driver.close();
      await driver.switchTo().window(originalHandle);
    }
    console.log(`Firefox ${(await driver.getCapabilities()).get("browserVersion")}: baseline, protected and background-tab checks passed`);
  } finally { await driver.quit(); }
});

test("Chromium: allowlist and early registration survive a full browser restart", { timeout: 60_000 }, async (t) => {
  const server = await startDemo();
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await mkdir(path.join(root, "test-results"), { recursive: true });
  const profile = await mkdtemp(path.join(root, "test-results/allowlist-profile-"));
  const extension = path.join(root, "dist/chromium");
  const launch = () => chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CHROMIUM_BINARY ? { executablePath: process.env.CHROMIUM_BINARY } : { channel: "chromium" }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  let context = await launch();
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const settings = await context.newPage();
    const popupURL = new URL("popup.html", worker.url()).href;
    await settings.goto(popupURL);
    await settings.getByRole("button", { name: "Удалить web.whatsapp.com", exact: true }).waitFor();
    await settings.locator("#domain").fill("127.0.0.1");
    await settings.locator('button[type="submit"]').click();
    await settings.getByRole("button", { name: "Удалить 127.0.0.1", exact: true }).waitFor();
    await context.close();
    context = await launch();
    // Playwright returns before the unpacked extension has finished loading.
    // Observe startup readiness without opening its popup or changing rules.
    const readyWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await readyWorker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await chrome.scripting.getRegisteredContentScripts()).length >= 2) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Persisted registrations were not restored");
    });
    const page = await context.newPage();
    // Do not open the popup first: the persisted registration must be enough.
    await page.goto(url.replace("127.0.0.1", "localhost"));
    assert.equal(await page.evaluate(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); }), "");
    await page.goto(url);
    assert.ok((await page.evaluate(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); })).length > 10);
    const restartedWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    await page.bringToFront();
    const newPopup = context.waitForEvent("page");
    // Keep the HTTP tab selected while the popup loads, as a toolbar popup
    // does. This exercises the real current-domain toggle, not just the form.
    await restartedWorker.evaluate((address) => chrome.tabs.create({ url: address, active: false }), popupURL);
    const popup = await newPopup;
    await popup.waitForFunction(() => document.getElementById("current-host")?.textContent === "127.0.0.1"
      && !document.getElementById("toggle-site").disabled);
    await popup.locator("#toggle-site").click();
    await popup.waitForFunction(() => !document.querySelector('[aria-label="Удалить 127.0.0.1"]'));
    await page.reload();
    assert.equal(await page.evaluate(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); }), "", "Current-domain toggle re-enables protection");
    await popup.locator("#toggle-site").click();
    await popup.getByRole("button", { name: "Удалить 127.0.0.1", exact: true }).waitFor();
    await popup.screenshot({ path: path.join(root, "test-results/allowlist-popup.png"), fullPage: true });
    await popup.locator("#toggle-site").click();
    await popup.waitForFunction(() => !document.querySelector('[aria-label="Удалить 127.0.0.1"]'));
    await popup.evaluate(() => { document.getElementById("features").closest("details").open = true; });
    await popup.locator("#compatible-profile").click();
    await popup.locator("#save-features").click();
    await popup.waitForFunction(() => !document.getElementById("pause-protection").disabled && document.getElementById("site-state").textContent.includes("перезагрузка"));
    await page.reload();
    assert.ok((await page.evaluate(() => { getSelection().selectAllChildren(document.getElementById("sample-text")); return String(getSelection()); })).length > 10, "Compatible-profile UI restores native selection");
    assert.equal(await page.evaluate(() => Document.prototype.hasFocus.name), "activityShieldHasFocus");
    await popup.locator("#pause-protection").click();
    await popup.waitForFunction(() => document.getElementById("pause-protection").textContent === "Возобновить защиту" && !document.getElementById("pause-protection").disabled);
    await page.reload();
    assert.notEqual(await page.evaluate(() => Document.prototype.hasFocus.name), "activityShieldHasFocus", "Pause button really stops protection");
    await popup.locator("#pause-protection").click();
    await popup.waitForFunction(() => document.getElementById("pause-protection").textContent === "Пауза на всех сайтах" && !document.getElementById("pause-protection").disabled);
    await page.reload();
    assert.equal(await page.evaluate(() => Document.prototype.hasFocus.name), "activityShieldHasFocus", "Resume preserves compatible profile");
    await popup.locator("#refresh-status").click();
    await popup.waitForFunction(() => document.getElementById("site-state").textContent === "Скрипты защиты загружены.");
    await popup.screenshot({ path: path.join(root, "test-results/profiles-popup.png"), fullPage: true });
  } finally { await context.close(); }
});
