/* Best-effort geometry privacy. CSS/layout are still controlled by the browser. */
(() => {
  "use strict";
  if (window.matchMedia.name === "activityShieldMatchMedia") return;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const nativeWidthGetter = descriptor(window, "innerWidth")?.get || descriptor(Window.prototype, "innerWidth")?.get;
  const nativeMatchMedia = window.matchMedia;
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeStop = Event.prototype.stopImmediatePropagation;
  const initial = { width: innerWidth, height: innerHeight, deviceWidth: screen.width,
    deviceHeight: screen.height, resolution: devicePixelRatio };
  function fixed(object, key, value) {
    const own = descriptor(object, key);
    if (!own || own.configurable) define(object, key, { configurable: true, enumerable: own?.enumerable ?? true, get: () => value });
  }
  function silence(target, type) {
    apply(nativeAdd, target, [type, (event) => apply(nativeStop, event, []), { capture: true, passive: true }]);
  }
  for (const key of ["innerWidth", "innerHeight", "outerWidth", "outerHeight", "devicePixelRatio"]) fixed(window, key, window[key]);
  for (const key of ["width", "height", "availWidth", "availHeight", "availLeft", "availTop"]) {
    if (key in screen) fixed(screen, key, screen[key]);
  }
  if ("orientation" in window) fixed(window, "orientation", window.orientation);
  if (screen.orientation) {
    fixed(screen.orientation, "type", screen.orientation.type);
    fixed(screen.orientation, "angle", screen.orientation.angle);
    silence(screen.orientation, "change");
  }
  silence(window, "resize");
  silence(window, "orientationchange");
  if (window.visualViewport) {
    for (const key of ["width", "height", "scale"]) fixed(visualViewport, key, visualViewport[key]);
    silence(visualViewport, "resize");
  }

  // Root viewport readers and root/body rectangles. Other element layout is
  // deliberately native: masking all layout would break editing and scrolling.
  const rects = new WeakMap();
  const nativeRect = Element.prototype.getBoundingClientRect;
  const NativeRect = DOMRect;
  const isRoot = (element) => element === document.documentElement || element === document.body;
  function dimensions(element) {
    if (!rects.has(element)) {
      const rect = apply(nativeRect, element, []);
      rects.set(element, { width: rect.width, height: rect.height });
    }
    return rects.get(element);
  }
  function captureRoots() {
    for (const element of [document.documentElement, document.body]) if (element) dimensions(element);
  }
  if (document.readyState !== "loading") captureRoots();
  apply(nativeAdd, document, ["DOMContentLoaded", captureRoots, { capture: true, once: true }]);
  define(Element.prototype, "getBoundingClientRect", { ...descriptor(Element.prototype, "getBoundingClientRect"),
    value: function getBoundingClientRect() {
      const actual = apply(nativeRect, this, []);
      if (!isRoot(this)) return actual;
      const size = dimensions(this);
      return new NativeRect(actual.x, actual.y, size.width, size.height);
    } });
  for (const [key, value] of [["clientWidth", initial.width], ["clientHeight", initial.height]]) {
    const original = descriptor(Element.prototype, key);
    if (original?.configurable) define(Element.prototype, key, { ...original, get: function () {
      if (this === document.documentElement || (document.compatMode === "BackCompat" && this === document.body)) return value;
      return apply(original.get, this, []);
    } });
  }
  const NativeObserver = window.ResizeObserver;
  if (NativeObserver) {
    window.ResizeObserver = class ResizeObserver extends NativeObserver {
      constructor(callback) {
        const seenRoots = new WeakSet();
        if (typeof callback !== "function") { super(callback); return; }
        super((entries, observer) => {
          const filtered = entries.filter(({ target }) => {
            if (!isRoot(target)) return true;
            if (seenRoots.has(target)) return false;
            seenRoots.add(target);
            return true;
          });
          if (filtered.length) apply(callback, undefined, [filtered, observer]);
        });
      }
    };
  }

  // Replace size-related media conditions with constant true/false conditions.
  // Native MediaQueryList objects retain listeners and non-size media features.
  // Unsupported size expressions fail closed to a constant false result.
  const values = { width: initial.width, height: initial.height,
    "device-width": initial.deviceWidth, "device-height": initial.deviceHeight,
    "aspect-ratio": initial.width / initial.height,
    "device-aspect-ratio": initial.deviceWidth / initial.deviceHeight,
    resolution: initial.resolution, "-webkit-device-pixel-ratio": initial.resolution,
    "-moz-device-pixel-ratio": initial.resolution };
  const geometry = /\b(?:width|height|aspect-ratio|orientation|resolution|device-pixel-ratio|viewport-segments)\b/i;
  const always = (value) => value ? "(color >= 0)" : "(color < 0)";
  const compare = (a, op, b) => Number.isFinite(a) && Number.isFinite(b)
    && (op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : a === b);
  let emSize;
  function fontUnit() {
    if (emSize) return emSize;
    // Infer the browser's initial media-query font size, including user prefs.
    // Use the native media engine only for calibration, never for page results.
    let low = 0, high = 65536;
    const realWidth = nativeWidthGetter ? apply(nativeWidthGetter, window, []) : initial.width;
    if (!realWidth) return emSize = 16;
    for (let count = 0; count < 32; count++) {
      const middle = (low + high) / 2;
      if (apply(nativeMatchMedia, window, [`(min-width: ${middle}em)`]).matches) low = middle;
      else high = middle;
    }
    return emSize = realWidth / ((low + high) / 2);
  }
  function amount(text, feature) {
    const value = text.trim().toLowerCase();
    const ratio = /^([\d.]+)\s*\/\s*([\d.]+)$/.exec(value);
    if (feature.includes("aspect-ratio")) return ratio ? +ratio[1] / +ratio[2] : Number(value);
    const part = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(px|em|rem|vw|vh|vmin|vmax|in|cm|mm|q|pt|pc|dppx|dpi|dpcm|x)?$/.exec(value);
    if (!part) return NaN;
    const number = +part[1], unit = part[2] || "";
    if (feature === "resolution") return number * ({ dppx: 1, x: 1, dpi: 1 / 96, dpcm: 2.54 / 96 }[unit] ?? NaN);
    if (feature.includes("pixel-ratio")) return unit ? NaN : number;
    if (unit === "em" || unit === "rem") return number * fontUnit();
    return number * ({ px: 1, "": number === 0 ? 1 : NaN, vw: initial.width / 100, vh: initial.height / 100,
      vmin: Math.min(initial.width, initial.height) / 100, vmax: Math.max(initial.width, initial.height) / 100,
      in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6, pt: 96 / 72, pc: 16 }[unit] ?? NaN);
  }
  function condition(text) {
    const clause = text.trim().toLowerCase();
    const colon = /^(?:(min|max)-)?([\w-]+)\s*:\s*(.+)$/.exec(clause);
    if (colon) {
      const [, bound, feature, value] = colon;
      if (feature === "orientation") return !bound && value === (initial.width > initial.height ? "landscape" : "portrait");
      if (!Object.hasOwn(values, feature)) return false;
      return compare(values[feature], bound === "min" ? ">=" : bound === "max" ? "<=" : "=", amount(value, feature));
    }
    if (Object.hasOwn(values, clause)) return values[clause] > 0;
    const parts = clause.split(/\s*(<=|>=|<|>|=)\s*/);
    const feature = parts.find((part) => Object.hasOwn(values, part));
    if (!feature || ![3, 5].includes(parts.length)) return false;
    for (let index = 1; index < parts.length; index += 2) {
      const read = (part) => part === feature ? values[feature] : amount(part, feature);
      if (!compare(read(parts[index - 1]), parts[index], read(parts[index + 1]))) return false;
    }
    return true;
  }
  const originalQueries = new WeakMap();
  const mediaGetter = descriptor(MediaQueryList.prototype, "media");
  if (mediaGetter?.configurable) define(MediaQueryList.prototype, "media", { ...mediaGetter, get: function () {
    return originalQueries.get(this) ?? apply(mediaGetter.get, this, []);
  } });
  window.matchMedia = function activityShieldMatchMedia(query) {
    const original = String(query);
    let rewritten = original.replace(/\(([^()]*)\)/g, (whole, text) => geometry.test(text) ? always(condition(text)) : whole);
    // Nested calc()/unknown geometry expressions must not expose live sizes.
    if (geometry.test(rewritten)) rewritten = always(false);
    const result = apply(nativeMatchMedia, this, [rewritten]);
    originalQueries.set(result, original);
    return result;
  };
})();
