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
  for (const type of ["mouseout", "mouseleave", "pointerout", "pointerleave"]) {
    capture(type, (event) => { if (event.relatedTarget === null) silence(event); });
  }
})();
