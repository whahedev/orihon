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
  const layer = marker([52.52, 13.405], { opacity: 0.7, zIndexOffset: 20, keyboard: false });
  assert.ok(layer instanceof Marker);
  assert.equal(layer.options.opacity, 0.7);
  assert.equal(layer.options.zIndexOffset, 20);
  assert.equal(layer.options.keyboard, false);
  layer.setOpacity(2).setZIndexOffset(90);
  assert.equal(layer.options.opacity, 1);
  assert.equal(layer.options.zIndexOffset, 90);
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

