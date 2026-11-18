// Ordinary page code. It neither installs nor imports the protection script.
(() => {
  const state = () => ({ hidden: document.hidden, visibilityState: document.visibilityState, hasFocus: document.hasFocus() });
  const initial = state();
  const visibilityHistory = [];
  const focusHistory = [];
  const fullscreenHistory = [];
  let fullscreenRequest = "idle";
  document.addEventListener("fullscreenchange", (event) => fullscreenHistory.push({
    active: Boolean(document.fullscreenElement), trusted: event.isTrusted
  }));
  let contextmenu = 0;
  let clicks = 0;
  let sequence = 0;
  window.addEventListener("visibilitychange", () => visibilityHistory.push(document.hidden));
  window.addEventListener("contextmenu", () => contextmenu++, true);
  for (const type of ["blur", "focus", "focusin", "focusout"]) {
    window.addEventListener(type, (event) => focusHistory.push(`${type}:${event.target === window ? "window" : event.target === document ? "document" : event.target.id || event.target.nodeName}`), true);
  }
  document.addEventListener("DOMContentLoaded", () => {
    const selection = getSelection();
    selection.selectAllChildren(document.getElementById("sample"));
    const input = document.getElementById("input");
    input.setSelectionRange(2, 7);
    const selected = { text: String(selection), count: selection.rangeCount, start: input.selectionStart, end: input.selectionEnd };
    selection.removeAllRanges();
    input.setSelectionRange(0, 0);
    document.getElementById("button").addEventListener("click", () => clicks++);
    document.getElementById("fullscreen").addEventListener("click", async () => {
      try {
        await document.documentElement.requestFullscreen();
        fullscreenRequest = "resolved";
      } catch (error) { fullscreenRequest = `rejected:${error.name}`; }
    });
    const mode = new URL(location.href).searchParams.get("mode");
    const report = () => {
      const data = {
        mode, sequence: ++sequence, initial, selection: selected,
        viewport: { width: innerWidth, height: innerHeight },
        current: state(), clicks, contextmenu, input: input.value,
        visibilityHistory, focusHistory, activeElement: document.activeElement?.id, userAgent: navigator.userAgent
      };
      data.fullscreen = {
        request: fullscreenRequest, active: Boolean(document.fullscreenElement),
        css: document.documentElement.matches(":fullscreen"), history: fullscreenHistory
      };
      const status = document.getElementById("status");
      const rendered = JSON.stringify({ mode, ...data.current, selected: selected.text, clicks, contextmenu, input: input.value, fullscreen: data.fullscreen }, null, 2);
      // Avoid constant accessibility tree mutations: Android uiautomator waits
      // for an idle tree before finding the native tap targets.
      if (status.textContent !== rendered) status.textContent = rendered;
      fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).catch(() => {});
    };
    report();
    setInterval(report, 250);
  });
})();
