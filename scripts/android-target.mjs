import { execFileSync } from "node:child_process";

// Resolve the enabled launcher alias instead of assuming <package>/.App.
// Firefox can switch that alias when the user chooses a different app icon.
export function androidTarget({ adbBin = "adb", device, firefoxApk = "org.mozilla.firefox", execute = execFileSync }) {
  const run = (args) => execute(adbBin, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const devices = run(["devices"]).split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[1] === "device").map((fields) => fields[0]);
  if (!device) {
    if (devices.length !== 1) throw new Error("Укажите --adb-device: должно быть выбрано одно подключённое устройство со статусом device.");
    device = devices[0];
  }
  if (!devices.includes(device)) throw new Error(`Устройство ${device} не подключено или не разрешена отладка по USB. Проверьте adb devices.`);
  const output = run(["-s", device, "shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", firefoxApk]);
  const component = output.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line.startsWith(`${firefoxApk}/`) && /^[\w.$]+\/[\w.$]+$/.test(line));
  if (!component) throw new Error(`Не найден компонент запуска ${firefoxApk}. Проверьте, что Firefox установлен и включён.`);
  const activity = component.slice(component.indexOf("/") + 1);
  return { device, firefoxApk, component: activity.startsWith(".") ? firefoxApk + activity : activity };
}
