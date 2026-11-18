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
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  function getter(prototype, name, read) {
    const original = descriptor(prototype, name);
    if (original?.configurable) define(prototype, name, { ...original, get: read });
  }
  function method(prototype, name, replacement) {
    const original = descriptor(prototype, name);
    if (original?.configurable) define(prototype, name, { ...original, value: replacement });
  }
  // Opt-in: preserve the initial pageshow used for application setup.
  for (const type of ["pagehide", "freeze", "resume"]) capture(type, silence);
  capture("pageshow", (event) => { if (event.persisted) silence(event); });
  getter(Document.prototype, "wasDiscarded", () => false);
})();
