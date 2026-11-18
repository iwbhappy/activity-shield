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
  if (Document.prototype.hasFocus.name === "activityShieldHasFocus") return;
  const nativeHasFocus = Document.prototype.hasFocus;
  const nativeHidden = descriptor(Document.prototype, "hidden").get;
  const nativeActiveElement = descriptor(Document.prototype, "activeElement").get;
  let suspendedElement = null;
  const reallyFocused = () => apply(nativeHasFocus, document, []);
  const reallyHidden = () => apply(nativeHidden, document, []);
  const activeElement = () => apply(nativeActiveElement, document, []);
  getter(Document.prototype, "hidden", () => false);
  getter(Document.prototype, "visibilityState", () => "visible");
  getter(Document.prototype, "webkitHidden", () => false);
  getter(Document.prototype, "webkitVisibilityState", () => "visible");
  method(Document.prototype, "hasFocus", function activityShieldHasFocus() { return true; });

  for (const type of ["visibilitychange", "webkitvisibilitychange"]) {
    capture(type, (event) => {
      if (reallyHidden()) suspendedElement = activeElement();
      silence(event);
    });
  }

  for (const type of ["blur", "focus", "focusin", "focusout"]) {
    capture(type, (event) => {
      const target = event.target;
      const losing = event.type === "blur" || event.type === "focusout";
      if (target === window || target === document) {
        if (losing && !reallyFocused() && !suspendedElement) suspendedElement = activeElement();
        silence(event);
        return;
      }

      // Firefox also blurs/refocuses the active *element* when the app leaves
      // or regains foreground. Letting those events through leaks the same
      // transition even when window/document events were filtered.
      if (losing) {
        if (reallyHidden() || (!event.relatedTarget && !reallyFocused())) {
          suspendedElement = target;
          silence(event);
        } else {
          // Genuine changes within an active page retain form handlers.
          suspendedElement = null;
        }
      } else if (reallyHidden() || !reallyFocused()) {
        silence(event);
      } else if (target === suspendedElement && !event.relatedTarget) {
        silence(event);
        // The focus + focusin pair must both stay hidden.
        if (event.type === "focusin") suspendedElement = null;
      } else {
        suspendedElement = null;
      }
    });
  }

})();
