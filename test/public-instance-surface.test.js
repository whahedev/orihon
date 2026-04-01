import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createMap } from "../dist/standard.js";
import { tileLayer, marker, polyline } from "../dist/standard.js";

// Module exports are guarded by public-api.test.js. This file guards the other half of the
// public surface: what an *instance* offers in autocomplete. Renderer bookkeeping that leaks
// as a writable property becomes a compatibility obligation the moment a plugin touches it.

function installDom(width = 800, height = 600) {
  const dom = new JSDOM("<!doctype html><div id='map'></div>", {
    pretendToBeVisual: true,
    url: "http://localhost/"
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Image = dom.window.Image;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const el = document.getElementById("map");
  Object.defineProperty(el, "clientWidth", { get: () => width });
  Object.defineProperty(el, "clientHeight", { get: () => height });
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height, right: width, bottom: height });
  return el;
}

function underscoreProperties(instance) {
  const names = new Set();
  for (const name of Object.getOwnPropertyNames(instance)) {
    if (name.startsWith("_")) names.add(name);
  }
  for (let proto = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name.startsWith("_") && name !== "_overlayAnchor" && name !== "_eventLatLng") names.add(name);
    }
  }
  return [...names];
}

test("map instances do not expose renderer or lifecycle internals", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 52.52, lng: 13.405 }, zoom: 10, controls: false });

  assert.deepEqual(underscoreProperties(map), [], "map leaks underscore-prefixed internals");
  for (const name of ["_destroyed", "_attributions", "_unsub", "_resizeObserver", "_viewSession"]) {
    assert.equal(name in map, false, `map still exposes ${name}`);
  }

  // Collections are readable views; mutation goes through the documented methods.
  assert.throws(() => { map.layers = new Set(); }, TypeError);
  assert.throws(() => { map.controls = new Set(); }, TypeError);
  assert.throws(() => { map.panes = {}; }, TypeError);

  // Live camera and configuration are views too: moving the camera or changing configuration
  // outside the documented setters would skip clamping, events and the render pass.
  assert.throws(() => { map.zoom = 15; }, TypeError);
  assert.throws(() => { map.center = { lat: 0, lng: 0 }; }, TypeError);
  assert.throws(() => { map.pixelOrigin = { x: 1, y: 2 }; }, TypeError);
  assert.throws(() => { map.size = { width: 1, height: 1 }; }, TypeError);
  assert.throws(() => { map.panVelocity = { x: 1, y: 1 }; }, TypeError);
  assert.throws(() => { map.options = {}; }, TypeError);
  assert.throws(() => { map.behaviors.states = {}; }, TypeError);

  // LatLng.lat / LatLng.lng are readonly in the type surface — a compile-time guarantee
  // checked in test/types/public-api.ts, since `readonly` leaves no runtime trap.

  // getCamera() is a detached snapshot: writing it must not reach the live camera.
  const camera = map.getCamera();
  assert.notEqual(camera.center, map.center);
  camera.pixelOrigin.x = 9999;
  camera.size.width = 1;
  assert.notEqual(map.pixelOrigin.x, 9999);
  assert.notEqual(map.size.width, 1);

  assert.equal(map.isDestroyed, false);
  map.destroy();
  assert.equal(map.isDestroyed, true);
});

test("raster tile layers report bookkeeping through getStats, not tile maps", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 52.52, lng: 13.405 }, zoom: 3, controls: false });
  const layer = tileLayer("https://tiles.test/{z}/{x}/{y}.png").addTo(map);

  assert.deepEqual(underscoreProperties(layer), [], "tile layer leaks underscore-prefixed internals");
  for (const name of ["tiles", "previousTiles", "cache", "level", "_queue", "_needed", "_rect"]) {
    assert.equal(name in layer, false, `tile layer still exposes ${name}`);
  }

  const stats = layer.getStats();
  assert.equal(stats.renderer, "dom");
  assert.equal(typeof stats.active, "number");
  assert.equal(typeof stats.retained, "number");
  assert.equal(typeof stats.cached, "number");
  assert.equal(typeof stats.loading, "number");
  map.destroy();
});

test("popup capability lives on InteractiveLayer, not on every layer", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 52.52, lng: 13.405 }, zoom: 3, controls: false });
  const tiles = tileLayer("https://tiles.test/{z}/{x}/{y}.png").addTo(map);

  // Core raster layers never had a working popup anchor; they no longer advertise one.
  assert.equal(typeof tiles.bindPopup, "undefined");
  assert.equal(typeof tiles.bindTooltip, "undefined");

  assert.equal(typeof marker({ lat: 52.52, lng: 13.405 }).bindPopup, "function");
  assert.equal(typeof polyline([{ lat: 52.5, lng: 13.4 }, { lat: 52.6, lng: 13.5 }]).bindTooltip, "function");
  map.destroy();
});
