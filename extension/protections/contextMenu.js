/* Packaged MAIN-world protection. No remote code or background calls. */
(() => {
  "use strict";
  const apply = Reflect.apply;
  const addListener = EventTarget.prototype.addEventListener;
  const stop = Event.prototype.stopImmediatePropagation;
  function silence(event) { apply(stop, event, []); }
  function capture(type, handler) {
    apply(addListener, window, [type, handler, { capture: true, passive: true }]);
  }
  capture("contextmenu", silence);
  for (const type of [
    "pointerdown", "pointerup", "pointermove", "pointerrawupdate", "pointercancel",
    "pointerover", "pointerout", "pointerenter", "pointerleave",
    "mousedown", "mouseup", "mousemove", "mouseover", "mouseout",
    "mouseenter", "mouseleave", "click", "auxclick", "dblclick"
  ]) {
    capture(type, (event) => {
      if (event.button === 2 || (event.buttons & 2) !== 0) silence(event);
    });
  }

  for (const type of ["keydown", "keyup"]) {
    capture(type, (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        silence(event);
      }
    });
  }
})();
