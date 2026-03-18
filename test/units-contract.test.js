import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Orihon, CRS, circle, circleMarker, objectManager, routingLayer, createStraightLineRoutingProvider } from "../dist/index.js";
import { ObjectSceneController } from "../dist/services/object-scene.js";
import { ObjectTrailStore } from "../dist/services/object-trail-store.js";
import { WebGLSymbolLayer } from "../dist/layers/webgl-symbol-layer.js";
import { WebGLPathBatch } from "../dist/layers/webgl-path-batch.js";
import { DrawHandler } from "../dist/draw/handler.js";

const center = { lat: 0, lng: 0 };

function mapFixture(t, options = {}) {
  const dom = new JSDOM("<!doctype html><div id='map'></div>");
  const original = new Map();
  for (const [key, value] of Object.entries({ document: dom.window.document, window: dom.window,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.getElementById("map");
  Object.defineProperties(container, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
  const map = new Orihon(container, { center, zoom: 3, controls: false, ...options });
  t.after(() => {
    map.destroy();
    dom.window.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return map;
}

test("camera duration is milliseconds, defaults to 250 and zero jumps immediately", (t) => {
  const map = mapFixture(t);
  let now = 1000;
  let pending = [];
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "requestAnimationFrame", (callback) => { pending.push(callback); return pending.length; });
  const tick = (time) => { now = time; const callbacks = pending; pending = []; callbacks.forEach((cb) => cb(now)); };
  let ended = 0;
  map.on("moveend", () => ended++);
  map.flyTo({ lat: 10, lng: 10 }, 5);
  tick(1125);
  assert.ok(map.getZoom() > 3 && map.getZoom() < 5);
  assert.equal(ended, 0);
  tick(1250);
  assert.equal(map.getZoom(), 5);
  assert.equal(ended, 1);
  map.flyTo(center, 3, { durationMs: 1000 });
  tick(1750);
  assert.ok(map.getZoom() > 3 && map.getZoom() < 5);
  tick(2250);
  assert.equal(map.getZoom(), 3);
  map.flyTo({ lat: 1, lng: 2 }, 4, { durationMs: 0 });
  assert.equal(map.getZoom(), 4);
  assert.equal(map.getCenter().lng, 2);
});

test("camera rejects removed names and invalid times before changing state", (t) => {
  const map = mapFixture(t);
  assert.throws(() => new Orihon(document.createElement("div"), { zoomAnimationDuration: 0.25 }), /zoomAnimationDurationMs/);
  for (const value of [-1, NaN, Infinity, "250"]) {
    assert.throws(() => new Orihon(document.createElement("div"), { zoomAnimationDurationMs: value }), RangeError);
    assert.throws(() => map.flyTo({ lat: 5, lng: 5 }, 6, { durationMs: value }), RangeError);
    assert.throws(() => map.fitWorld({ durationMs: value }), RangeError);
  }
  for (const run of [() => map.flyTo(center, 4, { duration: 1 }),
    () => map.fitWorld({ duration: 1 }), () => map.panInsideBounds([center, { lat: 10, lng: 10 }], { duration: 1 })]) {
    assert.throws(run, /durationMs/);
  }
  assert.equal(map.getZoom(), 3);
});

test("circles require one finite explicit unit and return isolated radius values", () => {
  for (const radius of [100, {}, null, { radiusMeters: 1, radiusMapUnits: 1 }, { radiusMeters: -1 },
    { radiusMeters: NaN }, { radiusMapUnits: Infinity }, { radiusMeters: "1" }]) {
    assert.throws(() => circle(center, radius));
  }
  const input = { radiusMapUnits: 5 };
  const shape = circle(center, input);
  input.radiusMapUnits = 999;
  shape.getRadius().radiusMapUnits = 999;
  assert.deepEqual(shape.getRadius(), { radiusMapUnits: 5 });
  assert.equal(shape.getBounds().toBBoxString(), "-5,-5,5,5");
  shape.setRadius({ radiusMapUnits: 0 });
  assert.equal(shape.getBounds().toBBoxString(), "0,0,0,0");
  assert.equal(shape.getRadiusMapUnits(), 0);
  assert.throws(() => shape.getRadiusMeters(), /using radiusMapUnits/);
  shape.setRadiusMapUnits(8);
  assert.equal(shape.getRadiusMapUnits(), 8);
  assert.deepEqual(shape.getRadius(), { radiusMapUnits: 8 });
  shape.setRadiusMeters(100);
  assert.equal(shape.getRadiusMeters(), 100);
  assert.throws(() => shape.getRadiusMapUnits(), /using radiusMeters/);
  assert.deepEqual(shape.getRadius(), { radiusMeters: 100 });
});

test("circle CRS mismatch leaves neither ghost layers nor partial radius changes", (t) => {
  const map = mapFixture(t, { crs: CRS.Simple });
  const shape = circle(center, { radiusMeters: 100 });
  const children = map.container.querySelectorAll("*").length;
  assert.throws(() => shape.addTo(map), /radiusMapUnits/);
  assert.equal(map.hasLayer(shape), false);
  assert.equal(shape.map, null);
  assert.equal(map.container.querySelectorAll("*").length, children);
  shape.setRadius({ radiusMapUnits: 5 }).addTo(map);
  assert.equal(map.hasLayer(shape), true);
  assert.throws(() => shape.setRadius({ radiusMeters: 100 }), /radiusMapUnits/);
  assert.throws(() => shape.setRadiusMeters(100), /radiusMapUnits/);
  assert.deepEqual(shape.getRadius(), { radiusMapUnits: 5 });
  assert.equal(shape.getRadiusMapUnits(), 5);
});

test("geographic maps reject map-unit circles and pixel markers retain zero", (t) => {
  const map = mapFixture(t);
  const shape = circle(center, { radiusMapUnits: 5 });
  assert.throws(() => shape.addTo(map), /CRS.Simple/);
  assert.equal(map.hasLayer(shape), false);
  const dot = circleMarker(center, { radiusPixels: 0 });
  assert.equal(dot.getRadiusPixels(), 0);
  dot.setRadiusPixels(12);
  assert.equal(dot.radiusPixels, 12);
  for (const value of [-1, NaN, Infinity, "4"]) assert.throws(() => dot.setRadiusPixels(value), RangeError);
  assert.equal(dot.getRadiusPixels(), 12);
  assert.throws(() => circleMarker(center, { radius: 10 }), /radiusPixels/);
});

test("Draw preserves unit-bearing circle radii including zero in GeoJSON", () => {
  for (const properties of [{ radiusMeters: 0 }, { radiusMapUnits: 25 }]) {
    const draw = new DrawHandler();
    draw.loadData({ type: "Feature", properties, geometry: { type: "Point", coordinates: [2, 3] } });
    const output = draw.toGeoJSON().features[0];
    assert.deepEqual(output.properties, properties);
    assert.deepEqual(output.geometry.coordinates, [2, 3]);
  }
  assert.throws(() => new DrawHandler().loadData({ type: "Feature", properties: { radius: 10 },
    geometry: { type: "Point", coordinates: [2, 3] } }), /radiusMeters or radiusMapUnits/);
});

test("motion interpolation uses milliseconds and zero resolves to destination at the same instant", (t) => {
  let now = 100;
  t.mock.method(performance, "now", () => now);
  const scene = new ObjectSceneController();
  scene.startMotion("a", 0, 0, 10, 20, 1000);
  now = 600;
  assert.deepEqual(scene.visualPosition("a", 0, 0), { lat: 5, lng: 10 });
  scene.startMotion("a", 0, 0, 20, 40, 0);
  assert.deepEqual(scene.visualPosition("a", 0, 0), { lat: 20, lng: 40 });
  assert.throws(() => scene.startMotion("a", 0, 0, 1, 1, -1), RangeError);
  scene.clear();
});

test("ObjectManager zero duration survives the animated update path", (t) => {
  const map = mapFixture(t);
  const manager = objectManager({ clusterize: false });
  manager.add({ id: "a", coordinates: center }).addTo(map);
  t.after(() => manager.destroy());
  manager.moveObject("a", { lat: 10, lng: 20 }, { animate: true, durationMs: 0 });
  assert.deepEqual(manager.scene.visualPosition("a", 10, 20), { lat: 10, lng: 20 });
  assert.throws(() => manager.moveObject("a", center, { duration: 1 }), /durationMs/);
  assert.throws(() => manager.moveObject("a", center, { durationMs: -1 }), RangeError);
  assert.deepEqual(manager.getObject("a").coordinates, { lat: 10, lng: 20 });
});

test("cluster radius and GPU camera timing reject legacy names", () => {
  assert.throws(() => objectManager({ clusterGridSize: 50 }), /clusterRadiusPixels/);
  const manager = objectManager({ clusterRadiusPixels: 0 });
  assert.equal(manager.options.clusterRadiusPixels, 20);
  assert.throws(() => manager.setClusterRadiusPixels(NaN), RangeError);
  manager.setClusterRadiusPixels(75);
  assert.equal(manager.options.clusterRadiusPixels, 75);
  manager.destroy();
  assert.throws(() => new WebGLPathBatch({ cameraRedrawInterval: 25 }), /cameraRedrawIntervalMs/);
  assert.throws(() => new WebGLPathBatch({ cameraSettleDelay: 25 }), /cameraSettleDelayMs/);
  assert.throws(() => new WebGLPathBatch({ cameraSettleDelayMs: -1 }), RangeError);
});

test("symbol motion validates units before replacing or patching instances", () => {
  const layer = new WebGLSymbolLayer();
  const instance = { lat: 0, lng: 0, icon: "", size: 10, rotation: 0, opacity: 1, tint: [1, 1, 1, 1], durationMs: 0 };
  layer.setInstances([instance]);
  assert.throws(() => layer.setInstances([{ ...instance, duration: 1 }]), /durationMs/);
  assert.throws(() => layer.patchInstance(0, { startTime: 0 }), /startTimeMs/);
  assert.throws(() => layer.patchInstance(0, { durationMs: -1 }), RangeError);
  assert.equal(instance.durationMs, 0);
});

test("trail age is milliseconds, with zero disabling age trimming", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const trails = new ObjectTrailStore();
  assert.throws(() => trails.configure("a", { maxAge: 1000 }), /maxAgeMs/);
  trails.configure("a", { maxAgeMs: 1000 });
  trails.append("a", 0, 0);
  now = 1500;
  trails.append("a", 1, 1);
  assert.equal(trails.list()[0].points.length, 2);
  now = 2001;
  assert.equal(trails.list().length, 0);
  trails.configure("a", { maxAgeMs: 0 });
  trails.append("a", 2, 2);
  now = 1e9;
  assert.equal(trails.list()[0].points.length, 2);
});

test("routing converts seconds into milliseconds and rejects legacy provider results", async () => {
  const waypoints = [center, { lat: 1, lng: 1 }];
  const layer = routingLayer({ provider: createStraightLineRoutingProvider() });
  const routes = await layer.route(waypoints);
  assert.equal(routes[0].durationMs, routes[0].distance / 13.9 * 1000);
  assert.equal(routes[1].durationMs, routes[1].distance / 11.2 * 1000);
  for (const time of [{ duration: 12 }, { durationMs: -1 }, { durationMs: Infinity }]) {
    const invalid = routingLayer({ provider: () => [{ coordinates: waypoints, ...time }] });
    await assert.rejects(invalid.route(waypoints));
    assert.deepEqual(invalid.getRoutes(), []);
  }
});
