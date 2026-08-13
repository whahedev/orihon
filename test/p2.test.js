import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><div id='map'></div>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLDivElement: dom.window.HTMLDivElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  HTMLCanvasElement: dom.window.HTMLCanvasElement,
  SVGElement: dom.window.SVGElement,
  SVGSVGElement: dom.window.SVGSVGElement,
  XMLSerializer: dom.window.XMLSerializer,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {}
});

const context = {
  scale() {}, fillRect() {}, drawImage() {}, save() {}, restore() {}, fillText() {},
  set fillStyle(_value) {}, set globalAlpha(_value) {}, set font(_value) {},
  set textAlign(_value) {}, set textBaseline(_value) {}
};
dom.window.HTMLCanvasElement.prototype.getContext = () => context;
dom.window.HTMLCanvasElement.prototype.toBlob = function(callback) {
  callback(new Blob(["png"], { type: "image/png" }));
};

const [{ Orihon, CRS, divIcon, marker }, controls, geo] = await Promise.all([
  import("../dist/index.js"),
  import("orihon/controls"),
  import("orihon/geo")
]);

function createContainer() {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientWidth: { value: 800, configurable: true },
    clientHeight: { value: 600, configurable: true }
  });
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} });
  document.body.appendChild(element);
  return element;
}

test("orihon/geo bufferPoint creates a closed geodesic polygon", () => {
  const feature = geo.bufferPoint([60, 30], 10_000, { steps: 16, properties: { id: 1 } });
  assert.equal(feature.geometry.type, "Polygon");
  assert.equal(feature.geometry.coordinates[0].length, 17);
  assert.deepEqual(feature.geometry.coordinates[0][0], feature.geometry.coordinates[0].at(-1));
  assert.deepEqual(feature.properties, { id: 1 });
  assert.throws(() => geo.bufferPoint([0, 0], -1), /non-negative/);
  assert.throws(() => geo.bufferPoint([0, 0], 1, { steps: Number.NaN }), /finite/);
});

test("marker rotation composes with positioning for DivIcon markers", () => {
  const map = new Orihon(createContainer(), { controls: false });
  const layer = marker([10, 20], {
    icon: divIcon({ content: "A" }),
    rotation: 45,
    rotationOrigin: "center bottom",
    draggable: true
  }).addTo(map);
  assert.match(layer.el.style.transform, /translate3d\(.+\) rotate\(45deg\)/);
  assert.equal(layer.el.style.transformOrigin, "center bottom");
  layer.setLatLng([11, 21]);
  assert.match(layer.el.style.transform, /rotate\(45deg\)/);
  map.destroy();
});

test("fullscreenControl uses the CSS fallback and localized labels", async () => {
  const map = new Orihon(createContainer(), { controls: false, locale: "ru" });
  const control = controls.fullscreenControl().addTo(map);
  assert.match(control.button.title, /экран/i);
  await control.toggle();
  assert.equal(map.container.classList.contains("oh-map-expanded"), true);
  assert.equal(control.button.getAttribute("aria-pressed"), "true");
  await control.toggle();
  assert.equal(map.container.classList.contains("oh-map-expanded"), false);
  map.destroy();
});

test("measureControl accumulates map distance and restores behaviors", () => {
  const map = new Orihon(createContainer(), { controls: false });
  const control = controls.measureControl().addTo(map).start();
  assert.equal(map.behaviors.isEnabled("drag"), false);
  map.emit("click", { latlng: [0, 0] });
  map.emit("click", { latlng: [0, 1] });
  assert.ok(control.getDistance() > 111_000);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(map.behaviors.isEnabled("drag"), true);
  assert.equal(control.active, false);
  map.destroy();
});

test("measureControl uses projected length when geodesic is false and owns document shortcuts", () => {
  const map = new Orihon(createContainer(), { controls: false, center: [60, 0], zoom: 5 });
  const geographic = controls.measureControl({ geodesic: true }).addTo(map).start();
  map.emit("click", { latlng: [60, 0] });
  map.emit("click", { latlng: [60, 1] });
  const geographicDistance = geographic.getDistance();
  geographic.finish().remove();

  const projected = controls.measureControl({ geodesic: false }).addTo(map).start();
  map.emit("click", { latlng: [60, 0] });
  map.emit("click", { latlng: [60, 1] });
  assert.ok(projected.getDistance() > geographicDistance * 1.9);

  const input = document.createElement("input");
  document.body.appendChild(input);
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(projected.active, true);
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(projected.active, false);
  input.remove();
  map.destroy();
});

test("graticule skips Simple CRS unless map units are requested", () => {
  const map = new Orihon(createContainer(), { controls: false, crs: CRS.Simple, center: [50, 50], zoom: 0 });
  const geographic = controls.graticuleLayer().addTo(map);
  assert.equal(geographic.svg.style.display, "none");
  const planar = controls.graticuleLayer({ units: "map", step: 10 }).addTo(map);
  assert.equal(planar.svg.style.display, "");
  assert.ok(planar.path.getAttribute("d").length > 0);
  map.destroy();
});

test("miniMap owns and releases its secondary map", () => {
  const map = new Orihon(createContainer(), { controls: false, center: [52, 13], zoom: 8 });
  const layer = controls.graticuleLayer();
  const control = controls.miniMap(layer).addTo(map);
  assert.ok(control.miniMap);
  assert.equal(layer.map, control.miniMap);
  control.remove();
  assert.equal(control.miniMap, null);
  assert.equal(layer.map, null);
  map.destroy();
});

test("map.exportPng exposes the async PNG contract in jsdom", async () => {
  const map = new Orihon(createContainer(), { controls: false });
  const blob = await map.exportPng({ pixelRatio: 2, includeControls: true });
  assert.equal(blob.type, "image/png");
  assert.ok(blob.size > 0);
  map.destroy();
});
