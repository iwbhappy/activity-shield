/* Runs in each matching document's MAIN world, before page scripts. */
(() => {
  "use strict";

  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply;
  const addListener = EventTarget.prototype.addEventListener;
  const stop = Event.prototype.stopImmediatePropagation;
  const dispatchEvent = EventTarget.prototype.dispatchEvent;
  const NativeEvent = Event;
  const defer = window.setTimeout.bind(window);
  const resolved = Promise.resolve.bind(Promise);
  const rejected = Promise.reject.bind(Promise);
  const nativeHasFocus = Document.prototype.hasFocus;
  const nativeHidden = descriptor(Document.prototype, "hidden").get;
  const nativeActiveElement = descriptor(Document.prototype, "activeElement").get;
  let suspendedElement = null;

  const reallyFocused = () => apply(nativeHasFocus, document, []);
  const reallyHidden = () => apply(nativeHidden, document, []);
  const activeElement = () => apply(nativeActiveElement, document, []);

  // Keep descriptors configurable: this is a privacy layer, not an integrity
  // boundary. A hostile page can detect or undo these changes (see README).
  function getter(prototype, name, read) {
    const original = descriptor(prototype, name);
    if (!original || !original.configurable) return;
    define(prototype, name, { ...original, get: read });
  }

  function method(prototype, name, replacement) {
    const original = descriptor(prototype, name);
    if (!original || !original.configurable) return;
    define(prototype, name, { ...original, value: replacement });
  }

  getter(Document.prototype, "hidden", () => false);
  getter(Document.prototype, "visibilityState", () => "visible");
  getter(Document.prototype, "webkitHidden", () => false);
  getter(Document.prototype, "webkitVisibilityState", () => "visible");
  method(Document.prototype, "hasFocus", function hasFocus() { return true; });

  // Fullscreen is virtual: accept a page request without hiding browser UI.
  // Only explicit page requests change this state; Esc, tab/app switches and
  // native fullscreen transitions do not expose the user's real actions.
  let fullscreenTarget = null;
  const fullscreenEvents = new WeakSet();
  const currentFullscreen = () => fullscreenTarget?.isConnected && fullscreenTarget.ownerDocument === document
    ? fullscreenTarget : null;
  function fullscreenIn(root) {
    let element = currentFullscreen();
    while (element) {
      const tree = element.getRootNode();
      if (tree === root) return element;
      element = tree instanceof ShadowRoot ? tree.host : null;
    }
    return null;
  }
  function fullscreenChange(target) {
    defer(() => {
      for (const type of ["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange"]) {
        // Dispatch aliases only when that API exists in this browser.
        if (type.startsWith("webkit") && !("webkitRequestFullscreen" in Element.prototype)) continue;
        if (type.startsWith("moz") && !("mozRequestFullScreen" in Element.prototype)) continue;
        const event = new NativeEvent(type, { bubbles: true, composed: true });
        fullscreenEvents.add(event);
        apply(dispatchEvent, target.isConnected ? target : document, [event]);
      }
    }, 0);
  }
  function requestVirtualFullscreen() {
    if (!(this instanceof Element) || this.ownerDocument !== document || !this.isConnected) {
      return rejected(new TypeError("Fullscreen requires an element in the current document."));
    }
    if (fullscreenTarget !== this) {
      fullscreenTarget = this;
      fullscreenChange(this);
    }
    return resolved(undefined);
  }
  function exitVirtualFullscreen() {
    if (this !== document || !currentFullscreen()) {
      return rejected(new TypeError("The document is not in fullscreen mode."));
    }
    const previous = fullscreenTarget;
    fullscreenTarget = null;
    fullscreenChange(previous);
    return resolved(undefined);
  }
  for (const name of ["fullscreenElement", "webkitFullscreenElement", "webkitCurrentFullScreenElement", "mozFullScreenElement"]) {
    const original = descriptor(Document.prototype, name);
    getter(Document.prototype, name, function () {
      return this === document ? fullscreenIn(document) : apply(original.get, this, []);
    });
    if (typeof ShadowRoot !== "undefined") {
      const shadowOriginal = descriptor(ShadowRoot.prototype, name);
      getter(ShadowRoot.prototype, name, function () {
        apply(shadowOriginal.get, this, []); // Preserve native brand validation.
        return fullscreenIn(this);
      });
    }
  }
  for (const name of ["fullscreen", "webkitIsFullScreen", "mozFullScreen"]) {
    const original = descriptor(Document.prototype, name);
    getter(Document.prototype, name, function () {
      return this === document ? Boolean(currentFullscreen()) : apply(original.get, this, []);
    });
  }
  method(Element.prototype, "requestFullscreen", requestVirtualFullscreen);
  method(Document.prototype, "exitFullscreen", exitVirtualFullscreen);
  // Legacy APIs return void rather than the standard Promise.
  for (const name of ["webkitRequestFullscreen", "webkitRequestFullScreen", "mozRequestFullScreen"]) {
    method(Element.prototype, name, function () { requestVirtualFullscreen.call(this).catch(() => {}); });
  }
  for (const name of ["webkitExitFullscreen", "webkitCancelFullScreen", "mozCancelFullScreen"]) {
    method(Document.prototype, name, function () { exitVirtualFullscreen.call(this).catch(() => {}); });
  }

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
    method(Selection.prototype, "toString", function toString() { return ""; });
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

  function silence(event) {
    // No preventDefault(): retain the browser context menu, selection and copy.
    apply(stop, event, []);
  }
  function capture(type, handler) {
    apply(addListener, window, [type, handler, { capture: true, passive: true }]);
  }

  for (const type of [
    "fullscreenchange", "fullscreenerror", "webkitfullscreenchange", "webkitfullscreenerror",
    "mozfullscreenchange", "mozfullscreenerror"
  ]) capture(type, (event) => {
    if (!fullscreenEvents.has(event)) silence(event);
  });

  for (const type of [
    "contextmenu", "selectstart", "selectionchange", "select"
  ]) capture(type, silence);

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
