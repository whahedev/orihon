import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
// Core alone, so locale packs really are loaded lazily: importing orihon/standard registers
// them synchronously and would remove the window this file exists to test. `ui/locale.js` is
// the same module instance the map uses, so awaiting it here awaits the map's pending load.
import { createMap } from "../dist/core.js";
import { ensureLocalePacks, localePackLoaded } from "../dist/ui/locale.js";

function container() {
  const dom = new JSDOM("<!doctype html><div id='map'></div>", { pretendToBeVisual: true, url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const el = document.getElementById("map");
  Object.defineProperty(el, "clientWidth", { get: () => 800 });
  Object.defineProperty(el, "clientHeight", { get: () => 600 });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  return el;
}

test("a pending locale load never overrides a locale chosen after it", async () => {
  assert.equal(localePackLoaded("ru"), false, "this file must run before any pack is loaded");

  const map = createMap(container(), { center: { lat: 0, lng: 0 }, zoom: 2, locale: "ru" });
  // The pack is still in flight; the map reports the requested language with English strings.
  assert.equal(map.locale.language, "ru");
  assert.equal(map.locale.layers, "Layers");

  // The application changes its mind before the chunk arrives. This takes the synchronous
  // branch, so it settles immediately and replaces the pending readiness.
  map.setLocale("en");
  assert.equal(map.locale.language, "en");
  await map.localeReady;

  // Let the constructor's load finish. Applying "ru" now would silently revert the map.
  await ensureLocalePacks();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(localePackLoaded("ru"), true, "the pack did finish loading");
  assert.equal(map.locale.language, "en", "the newer locale must win");
  assert.equal(map.locale.layers, "Layers");
  map.destroy();
});

test("a locale requested before the pack arrives is still applied when nothing supersedes it", async () => {
  const map = createMap(container(), { center: { lat: 0, lng: 0 }, zoom: 2, locale: "ru" });
  await map.localeReady;
  assert.equal(map.locale.layers, "Слои");
  map.destroy();
});
