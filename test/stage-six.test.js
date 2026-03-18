import test from "node:test";
import assert from "node:assert/strict";
import {
  CustomControl,
  Marker,
  Popup,
  customControl,
  locales,
  marker,
  resolveLocale,
  ruLocale
} from "../dist/index.js";

test("Marker exposes opacity and z-index controls", () => {
  const layer = marker({ lat: 52.52, lng: 13.405 }, { fillOpacity: 0.7, zIndexOffset: 20, keyboard: false });
  assert.ok(layer instanceof Marker);
  assert.equal(layer.options.opacity, 0.7);
  assert.equal(layer.options.zIndexOffset, 20);
  assert.equal(layer.options.keyboard, false);
  layer.setOpacity(2).setZIndexOffset(90);
  assert.equal(layer.options.opacity, 1);
  assert.equal(layer.options.zIndexOffset, 90);
});

test("Marker built-in appearance supports shape color and size", () => {
  const layer = marker({ lat: 0, lng: 0 }, {
    shape: "circle",
    fill: "#0f766e",
    strokeColor: "#ecfeff",
    size: 18,
    strokeWidth: 3
  });
  assert.equal(layer.options.shape, "circle");
  assert.equal(layer.options.color, "#0f766e");
  assert.equal(layer.options.strokeColor, "#ecfeff");
  assert.equal(layer.options.size, 18);
  assert.equal(layer.options.strokeWidth, 3);
  assert.deepEqual(layer.options.anchor, [12, 12]);
  layer.setAppearance({ shape: "square", size: 24, color: "#2563eb" });
  assert.equal(layer.options.shape, "square");
  assert.equal(layer.options.size, 24);
  assert.equal(layer.options.color, "#2563eb");
  assert.deepEqual(layer.options.anchor, [15, 15]);
  layer.setAppearance({ shape: "pin", size: 22, strokeWidth: 2 });
  assert.deepEqual(layer.options.anchor, [12, 36]);
  layer.setAppearance({ shape: "diamond", size: 22 });
  assert.equal(layer.options.shape, "diamond");
  assert.deepEqual(layer.options.anchor, [12, 36]);
});

test("Popup defaults to auto-pan and accepts keep-in-view options", () => {
  const overlay = new Popup("Details", {
    autoPanPadding: [24, 32],
    keepInView: true,
    locale: "ru"
  });
  assert.equal(overlay.options.autoPan, true);
  assert.deepEqual(overlay.options.autoPanPadding.toArray(), [24, 32]);
  assert.equal(overlay.options.keepInView, true);
});

test("locales are immutable presets with per-instance overrides", () => {
  const russian = resolveLocale("ru");
  const custom = resolveLocale({ zoomIn: "Closer" });
  assert.equal(russian.layers, "Слои");
  assert.equal(russian.kilometers, "км");
  assert.equal(custom.zoomIn, "Closer");
  assert.equal(custom.zoomOut, "Zoom out");
  assert.equal(Object.isFrozen(ruLocale), true);
  assert.deepEqual(Object.keys(locales).sort(), ["ar", "da", "de", "en", "fr", "hi", "ru", "tr", "zh"]);
  assert.equal(resolveLocale("en").mapLabel, "Interactive map");
  assert.equal(resolveLocale("ru").language, "ru");
  assert.equal("fullscreen" in resolveLocale("en"), false);
  assert.equal(resolveLocale("ar").zoomIn, "تكبير");
  assert.equal(resolveLocale("tr").zoomOut, "Uzaklaştır");
  assert.equal(resolveLocale("zh").layers, "图层");
  assert.equal(resolveLocale("de").locate, "Meinen Standort anzeigen");
  assert.equal(resolveLocale("fr").closePopup, "Fermer la fenêtre");
  assert.equal(resolveLocale("da").baseMaps, "Grundkort");
  assert.equal(resolveLocale("hi").overlays, "अतिरिक्त परतें");
  assert.equal(Object.isFrozen(locales.ar), true);
});

test("custom controls expose content and position lifecycle", () => {
  const control = customControl("Status", { position: "bottom-left", ariaLabel: "Status" });
  assert.ok(control instanceof CustomControl);
  assert.equal(control.getContent(), "Status");
  assert.equal(control.getPosition(), "bottom-left");
  control.setContent("Ready").setPosition("top-left");
  assert.equal(control.getContent(), "Ready");
  assert.equal(control.getPosition(), "top-left");
});
