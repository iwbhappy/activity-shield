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
  if (Element.prototype.requestFullscreen?.name === "activityShieldRequestFullscreen") return;
  const dispatchEvent = EventTarget.prototype.dispatchEvent;
  const NativeEvent = Event;
  const defer = window.setTimeout.bind(window);
  const resolved = Promise.resolve.bind(Promise);
  const rejected = Promise.reject.bind(Promise);
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
  function activityShieldRequestFullscreen() {
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
  method(Element.prototype, "requestFullscreen", activityShieldRequestFullscreen);
  method(Document.prototype, "exitFullscreen", exitVirtualFullscreen);
  // Legacy APIs return void rather than the standard Promise.
  for (const name of ["webkitRequestFullscreen", "webkitRequestFullScreen", "mozRequestFullScreen"]) {
    method(Element.prototype, name, function () { activityShieldRequestFullscreen.call(this).catch(() => {}); });
  }
  for (const name of ["webkitExitFullscreen", "webkitCancelFullScreen", "mozCancelFullScreen"]) {
    method(Document.prototype, name, function () { exitVirtualFullscreen.call(this).catch(() => {}); });
  }

  for (const type of [
    "fullscreenchange", "fullscreenerror", "webkitfullscreenchange", "webkitfullscreenerror",
    "mozfullscreenchange", "mozfullscreenerror"
  ]) capture(type, (event) => {
    if (!fullscreenEvents.has(event)) silence(event);
  });

})();
