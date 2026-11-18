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
  if (globalThis.Selection?.prototype.toString.name === "activityShieldSelectionToString") return;
  // Retain the real Selection object and all native mutation methods. Browser
  // selection/clipboard still work; JS readers see an empty selection.
  if (typeof Selection !== "undefined") {
    const empty = {
      anchorNode: null, anchorOffset: 0,
      focusNode: null, focusOffset: 0,
      baseNode: null, baseOffset: 0,
      extentNode: null, extentOffset: 0,
      rangeCount: 0, isCollapsed: true, type: "None", direction: "none"
    };
    for (const [name, value] of Object.entries(empty)) {
      getter(Selection.prototype, name, () => value);
    }
    method(Selection.prototype, "toString", function activityShieldSelectionToString() { return ""; });
    method(Selection.prototype, "containsNode", function containsNode() { return false; });
    method(Selection.prototype, "getRangeAt", function getRangeAt() {
      throw new DOMException("The selection contains no ranges.", "IndexSizeError");
    });
    method(Selection.prototype, "getComposedRanges", function getComposedRanges() { return []; });
  }

  // Selection in text fields is a separate API. Preserve native setters so
  // setSelectionRange() and browser editing can still change the real caret.
  for (const prototype of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    for (const name of ["selectionStart", "selectionEnd", "selectionDirection"]) {
      const original = descriptor(prototype, name);
      if (!original?.get || !original.configurable) continue;
      getter(prototype, name, function () {
        // Unsupported input types must continue returning null.
        const actual = apply(original.get, this, []);
        return actual === null ? null : name === "selectionDirection" ? "none" : 0;
      });
    }
  }

  for (const type of ["selectstart", "selectionchange", "select"]) capture(type, silence);
})();
