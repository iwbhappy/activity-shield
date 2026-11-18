import test from "node:test";
import assert from "node:assert/strict";
import { androidTarget } from "../scripts/android-target.mjs";

function adbOutput(launcher, devices = "List of devices attached\ntest-phone\tdevice\n") {
  return (_binary, args) => args[0] === "devices" ? devices : launcher;
}
test("Firefox alternate icon: resolve enabled AppMinimal alias, without assuming App", () => {
  const result = androidTarget({ execute: adbOutput("priority=0 preferredOrder=0\norg.mozilla.firefox/.AppMinimal\n") });
  assert.deepEqual(result, { device: "test-phone", firefoxApk: "org.mozilla.firefox", component: "org.mozilla.firefox.AppMinimal" });
});
test("Firefox default launcher and fully qualified Beta launcher resolve correctly", () => {
  assert.equal(androidTarget({ execute: adbOutput("org.mozilla.firefox/.App\n") }).component, "org.mozilla.firefox.App");
  assert.equal(androidTarget({ firefoxApk: "org.mozilla.firefox_beta", execute: adbOutput("org.mozilla.firefox_beta/org.mozilla.fenix.HomeActivity\n") }).component, "org.mozilla.fenix.HomeActivity");
});
test("Do not select an arbitrary device, an unauthorized device or a missing activity", () => {
  assert.throws(() => androidTarget({ execute: adbOutput("", "List of devices attached\nA device\nB device\n") }), /--adb-device/);
  assert.throws(() => androidTarget({ device: "A", execute: adbOutput("", "List of devices attached\nA unauthorized\n") }), /отладка/);
  assert.throws(() => androidTarget({ execute: adbOutput("No activity found\n") }), /компонент/);
});
