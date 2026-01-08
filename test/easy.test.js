import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/"
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {}
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator
});
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

const [{ createMap }, { GeoJSONLayer, Marker, Polygon, Polyline, TileLayer, marker }] = await Promise.all([
  import("orihon/easy"),
  import("orihon/standard")
]);

function container() {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientWidth: { value: 800, configurable: true },
    clientHeight: { value: 600, configurable: true }
  });
  element.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0, toJSON() {}
  });
  document.body.appendChild(element);
  return element;
}

test("orihon/easy creates a Standard map with an owned basemap", () => {
  const map = createMap(container(), {
    center: { lat: 55.751244, lng: 37.618423 },
    zoom: 12,
    basemap: {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap contributors"
    }
  });

  assert.deepEqual(map.getCenter().toArray(), [55.751244, 37.618423]);
  assert.equal(map.getZoom(), 12);
  assert.ok(map.getBasemap() instanceof TileLayer);
  assert.match(map.getBasemap().getTileUrl(1, 2, 3), /\/3\/1\/2\.png$/);

  const first = map.getBasemap();
  map.setBasemap("https://example.test/{z}/{x}/{y}.png");
  assert.equal(first.map, null);
  assert.match(map.getBasemap().getTileUrl(1, 2, 3), /^https:\/\/example\.test/);

  map.setBasemap(false);
  assert.equal(map.getBasemap(), null);
  map.remove();
});

test("orihon/easy addMarker composes marker, popup and tooltip", () => {
  const map = createMap(container(), { center: [55.75, 37.62], zoom: 10 });
  const layer = map.addMarker({
    position: { lat: 55.751244, lng: 37.618423 },
    title: "Москва",
    popup: "Москва",
    tooltip: "Столица"
  });

  assert.ok(layer instanceof Marker);
  assert.equal(layer.map, map);
  assert.deepEqual(layer.getLatLng().toArray(), [55.751244, 37.618423]);
  assert.ok(layer.getPopup());
  assert.ok(layer.getTooltip());

  const positional = map.addMarker([55.76, 37.63], { popup: "Positional overload" });
  assert.ok(positional instanceof Marker);
  assert.ok(positional.getPopup());

  const detached = marker([55.77, 37.64]);
  assert.equal(map.add(detached), map);
  assert.equal(map.hasLayer(detached), true);

  map.remove();
});

test("orihon/easy map-centric addX methods return regular layers", () => {
  const map = createMap(container(), { center: [52.52, 13.405], zoom: 10 });
  const tiles = map.addTileLayer("https://example.test/{z}/{x}/{y}.png");
  const line = map.addPolyline([[52.50, 13.38], [52.54, 13.43]], { stroke: "#2563eb" });
  const area = map.addPolygon([
    [52.50, 13.38], [52.50, 13.43], [52.54, 13.43], [52.50, 13.38]
  ], { fill: "#2563eb", fillOpacity: 0.2 });
  const data = map.addGeoJSON({
    type: "Feature",
    properties: { name: "Berlin" },
    geometry: { type: "Point", coordinates: [13.405, 52.52] }
  });

  assert.ok(tiles instanceof TileLayer);
  assert.ok(line instanceof Polyline);
  assert.ok(area instanceof Polygon);
  assert.ok(data instanceof GeoJSONLayer);
  for (const layer of [tiles, line, area, data]) assert.equal(map.hasLayer(layer), true);

  map.remove();
});

test("orihon/easy map.add accepts declarative layer descriptions", () => {
  const map = createMap(container(), { center: [55.7558, 37.6176], zoom: 10 });
  const point = map.add({
    type: "marker",
    position: { lng: 37.6176, lat: 55.7558 },
    popup: "Москва"
  });
  const line = map.add({
    type: "polyline",
    coordinates: [
      { lng: 37.60, lat: 55.75 },
      { lng: 37.65, lat: 55.77 }
    ],
    style: { width: 4, opacity: 0.8 }
  });
  const area = map.add({
    type: "polygon",
    coordinates: [
      [55.74, 37.59], [55.74, 37.66], [55.78, 37.66], [55.74, 37.59]
    ],
    style: { fill: "#2563eb", fillOpacity: 0.2 }
  });
  const data = map.add({
    type: "geojson",
    data: {
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [37.6176, 55.7558] }
    }
  });
  const raster = map.add({
    type: "raster",
    url: "https://example.test/{z}/{x}/{y}.png"
  });

  assert.ok(point instanceof Marker);
  assert.ok(point.getPopup());
  assert.ok(line instanceof Polyline);
  assert.equal(line.options.strokeWidth, 4);
  assert.equal(line.options.strokeOpacity, 0.8);
  assert.ok(area instanceof Polygon);
  assert.ok(data instanceof GeoJSONLayer);
  assert.ok(raster instanceof TileLayer);
  for (const layer of [point, line, area, data, raster]) assert.equal(map.hasLayer(layer), true);

  map.remove();
});
