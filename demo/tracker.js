/* Deliberately ordinary page code: it has no extension-specific access. */
(() => {
  "use strict";
  const counters = Object.create(null);
  const events = [];
  const initial = { hidden: document.hidden, visibilityState: document.visibilityState, hasFocus: document.hasFocus() };
  window.demo = { counters, events, initial };

  function record(event) {
    const key = `${event.type}:${event.target === window ? "window" : event.target === document ? "document" : event.target.id || event.target.nodeName}`;
    counters[key] = (counters[key] || 0) + 1;
    events.unshift(`${new Date().toLocaleTimeString()} ${key} (${event.isTrusted ? "native" : "synthetic"})`);
    events.length = Math.min(events.length, 80);
    const log = document.getElementById("events");
    if (log) log.textContent = events.join("\n");
  }

  for (const type of ["fullscreenchange", "fullscreenerror", "webkitfullscreenchange", "mozfullscreenchange", "visibilitychange", "focus", "blur", "focusin", "focusout", "contextmenu", "selectionchange", "selectstart", "select", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "click", "keydown", "keyup"]) {
    window.addEventListener(type, record, true);
  }

  window.demo.snapshot = () => {
    const selection = window.getSelection();
    const input = document.getElementById("text-input");
    return {
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      fullscreenElement: document.fullscreenElement?.id || document.fullscreenElement?.nodeName || null,
      fullscreen: Boolean(document.fullscreenElement),
      selection: String(selection),
      documentSelection: String(document.getSelection()),
      rangeCount: selection?.rangeCount,
      anchorNode: selection?.anchorNode?.nodeName ?? null,
      type: selection?.type,
      inputSelectionStart: input?.selectionStart,
      inputSelectionEnd: input?.selectionEnd
    };
  };
  document.addEventListener("DOMContentLoaded", () => {
    let fullscreenStarted = false;
    const fullscreenStatus = () => {
      const status = document.getElementById("fullscreen-status");
      if (status) status.textContent = !fullscreenStarted ? "Проверка ещё не запущена."
        : document.fullscreenElement ? "Сайт разрешает продолжить: Fullscreen API сообщает полный экран."
        : "Сайт требует вернуться в полный экран.";
    };
    document.addEventListener("fullscreenchange", fullscreenStatus);
    document.getElementById("fullscreen-start")?.addEventListener("click", async () => {
      fullscreenStarted = true;
      window.demo.fullscreenRequest = "pending";
      try {
        await document.documentElement.requestFullscreen();
        window.demo.fullscreenRequest = "resolved";
        fullscreenStatus();
      } catch (error) {
        window.demo.fullscreenRequest = `rejected:${error.name}`;
        document.getElementById("fullscreen-status").textContent = `Запрос отклонён: ${error.name}`;
      }
    });
    document.getElementById("fullscreen-exit")?.addEventListener("click", async () => {
      try { await document.exitFullscreen(); fullscreenStatus(); }
      catch (error) { document.getElementById("fullscreen-status").textContent = `Выход: ${error.name}`; }
    });
    setInterval(fullscreenStatus, 250);
    const state = document.getElementById("state");
    if (state) {
      const render = () => { state.textContent = JSON.stringify(window.demo.snapshot(), null, 2); };
      render();
      setInterval(render, 250);
    }
    let clicks = 0;
    document.getElementById("ordinary-button")?.addEventListener("click", (event) => {
      event.target.textContent = `Обычная кнопка: ${++clicks}`;
    });
    document.getElementById("clear")?.addEventListener("click", () => {
      events.length = 0;
      for (const key of Object.keys(counters)) delete counters[key];
      document.getElementById("events").textContent = "";
    });
  });
})();
