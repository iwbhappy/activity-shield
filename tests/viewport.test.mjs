import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Builder, By } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { startDemo } from "../scripts/serve-demo.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function prepare(read) {
  await read(() => {
    const sample = document.createElement("div");
    sample.id = "viewport-css-probe";
    sample.style.cssText = "width:100vw;height:10px";
    document.body.append(sample);
    const queries = ["(max-width: 800px)", "(orientation: portrait)", "(min-aspect-ratio: 1/1)",
      "(600px <= width <= 900px)", "(width >= 1000px)", "(min-width: 60em)", "(min-width: 60rem)",
      "(width > calc(700px + 1px))", "(prefers-color-scheme: dark)"];
    const probe = window.viewportProbe = { events: 0, mediaEvents: 0, rootEvents: 0, childEvents: 0,
      lists: queries.map((query) => matchMedia(query)) };
    addEventListener("resize", () => { probe.events++; });
    for (const list of probe.lists) list.addEventListener("change", () => { probe.mediaEvents++; });
    probe.observer = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === document.documentElement) probe.rootEvents++; else probe.childEvents++;
    });
    probe.observer.observe(document.documentElement);
    probe.observer.observe(sample);
    window.viewportSnapshot = () => ({
      sizes: [innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
        screen.width, screen.height, screen.availWidth, screen.availHeight,
        screen.orientation?.type, screen.orientation?.angle, visualViewport?.width, visualViewport?.height,
        document.documentElement.clientWidth, document.documentElement.clientHeight,
        document.documentElement.getBoundingClientRect().width, document.body.getBoundingClientRect().width],
      media: probe.lists.map((list) => list.matches),
      freshMedia: probe.lists.map((list) => matchMedia(list.media).matches),
      queries: probe.lists.map((list) => list.media),
      events: probe.events, mediaEvents: probe.mediaEvents, rootEvents: probe.rootEvents,
      childEvents: probe.childEvents, cssWidth: sample.getBoundingClientRect().width
    });
  });
  await read(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return read(() => viewportSnapshot());
}
async function verify(read, resize, protectedMode) {
  const before = await prepare(read);
  await resize(); // Actual browser viewport/window resize, no synthetic resize event.
  await read(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await read(() => viewportSnapshot());
  assert.notEqual(after.cssWidth, before.cssWidth, "The browser really resized; CSS layout is an explicitly remaining channel");
  assert.deepEqual(after.queries, before.queries, "MediaQueryList.media retains the caller's query");
  if (protectedMode) {
    assert.deepEqual(after.sizes, before.sizes, "Main dimensions, orientation and root readers stay fixed");
    assert.deepEqual(after.media, before.media);
    assert.deepEqual(after.freshMedia, before.freshMedia, "Creating a fresh query cannot poll the resized viewport");
    assert.equal(after.events, 0);
    assert.equal(after.mediaEvents, 0);
    assert.equal(after.rootEvents, before.rootEvents, "Existing root ResizeObserver receives no size transition");
  } else {
    assert.notDeepEqual(after.sizes, before.sizes);
    assert.notDeepEqual(after.media, before.media);
    assert.ok(after.events > 0);
    assert.ok(after.mediaEvents > 0);
  }
  assert.ok(after.childEvents > before.childEvents, "Normal element observers remain native");
}

for (const engine of ["chromium", "firefox"]) test(`${engine}: real resize, protected APIs and native control`, { timeout: 90_000 }, async (t) => {
  const server = await startDemo();
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  if (engine === "chromium") {
    for (const protectedMode of [false, true]) {
      const extension = path.join(root, "dist/chromium");
      const context = await chromium.launchPersistentContext("", { headless: true, viewport: { width: 1200, height: 800 },
        ...(process.env.CHROMIUM_BINARY ? { executablePath: process.env.CHROMIUM_BINARY } : { channel: "chromium" }),
        args: protectedMode ? [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] : [] });
      try {
        const page = await context.newPage();
        if (protectedMode) {
          const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
          await page.goto(new URL("popup.html", worker.url()).href);
          await page.locator("#pause-protection:not([disabled])").waitFor();
        }
        await page.goto(url);
        await verify((fn) => page.evaluate(fn), () => page.setViewportSize({ width: 650, height: 1000 }), protectedMode);
      } finally { await context.close(); }
    }
  } else {
    process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";
    const options = new firefox.Options().addArguments("-headless", "--allow-system-access");
    if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
    const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
    const read = (fn) => driver.executeScript(`return (${fn.toString()})();`);
    try {
      for (const protectedMode of [false, true]) {
        await driver.manage().window().setRect({ width: 1200, height: 900 });
        if (protectedMode) {
          const id = await driver.installAddon(path.join(root, "dist/firefox"), true);
          await driver.setContext("chrome");
          const uuid = await driver.executeScript("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))[arguments[0]]", id);
          await driver.setContext("content");
          await driver.get(`moz-extension://${uuid}/popup.html`);
          await driver.wait(() => driver.findElement(By.id("pause-protection")).isEnabled(), 10_000);
        }
        await driver.get(url);
        await verify(read, () => driver.manage().window().setRect({ width: 650, height: 1100 }), protectedMode);
      }
    } finally { await driver.quit(); }
  }
});
