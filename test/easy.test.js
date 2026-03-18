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

const [{ createMap }, { GeoJSONLayer, Layer, Marker, Polygon, Polyline, TileLayer, marker, wmtsTileLayer }] = await Promise.all([
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
  map.destroy();
});

test("orihon/easy accepts any ready Layer as its basemap", () => {
  const wmts = wmtsTileLayer("https://example.test/{TileMatrix}/{TileCol}/{TileRow}.png", {
    layer: "basemap",
    tileMatrixSet: "EPSG:3857"
  });
  const map = createMap(container(), {
    center: { lat: 55.751244, lng: 37.618423 },
    zoom: 12,
    basemap: wmts
  });

  assert.equal(map.getBasemap(), wmts);
  assert.equal(map.hasLayer(wmts), true);

  class CustomBasemap extends Layer {}
  const custom = new CustomBasemap({ attribution: "Custom data" });
  map.setBasemap(custom);

  assert.equal(wmts.map, null);
  assert.equal(map.getBasemap(), custom);
  assert.equal(map.hasLayer(custom), true);

  map.setBasemap(custom);
  assert.equal(map.getBasemap(), custom);
  assert.equal(map.hasLayer(custom), true);

  map.setBasemap(null);
  assert.equal(custom.map, null);
  assert.equal(map.getBasemap(), null);
  map.destroy();
});

test("orihon/easy addMarker is object-first with nested appearance", () => {
  const map = createMap(container(), { center: { lat: 55.75, lng: 37.62 }, zoom: 10 });
  const layer = map.addMarker({
    position: { lat: 55.751244, lng: 37.618423 },
    title: "Москва",
    appearance: { shape: "pin", color: "#2563eb" },
    popup: "Москва",
    tooltip: "Столица"
  });

  assert.ok(layer instanceof Marker);
  assert.equal(layer.map, map);
  assert.deepEqual(layer.getLatLng().toArray(), [55.751244, 37.618423]);
  assert.equal(layer.options.color, "#2563eb");
  assert.ok(layer.getPopup());
  assert.ok(layer.getTooltip());

  assert.throws(() => map.addMarker({ lat: 55.76, lng: 37.63 }), /position is required/);

  const detached = marker({ lat: 55.77, lng: 37.64 });
  assert.equal(map.addLayer(detached), map);
  assert.equal(map.hasLayer(detached), true);
  assert.equal(typeof map.add, "undefined");

  class WeatherLayer extends Layer {
    type = "weather";
  }
  const weather = new WeatherLayer();
  assert.equal(weather.addTo(map), weather);
  assert.equal(map.hasLayer(weather), true);

  map.destroy();
});

test("orihon/easy map-centric addX methods are object-first", () => {
  const map = createMap(container(), { center: { lat: 52.52, lng: 13.405 }, zoom: 10 });
  const tiles = map.addTileLayer({ url: "https://example.test/{z}/{x}/{y}.png" });
  const line = map.addPolyline({
    points: [{ lat: 52.50, lng: 13.38 }, { lat: 52.54, lng: 13.43 }],
    style: { stroke: "#2563eb" }
  });
  const area = map.addPolygon({
    rings: [
      { lat: 52.50, lng: 13.38 }, { lat: 52.50, lng: 13.43 }, { lat: 52.54, lng: 13.43 }, { lat: 52.50, lng: 13.38 }
    ],
    style: { fill: "#2563eb", fillOpacity: 0.2 }
  });
  const data = map.addGeoJSON({
    data: {
      type: "Feature",
      properties: { name: "Berlin" },
      geometry: { type: "Point", coordinates: [13.405, 52.52] }
    }
  });
  const withPopup = map.addMarker({
    position: { lng: 37.6176, lat: 55.7558 },
    popup: "Москва"
  });
  const styled = map.addPolyline({
    points: [
      { lng: 37.60, lat: 55.75 },
      { lng: 37.65, lat: 55.77 }
    ],
    style: { strokeWidth: 4, strokeOpacity: 0.8 }
  });

  assert.ok(tiles instanceof TileLayer);
  assert.ok(line instanceof Polyline);
  assert.ok(area instanceof Polygon);
  assert.ok(data instanceof GeoJSONLayer);
  assert.ok(withPopup instanceof Marker);
  assert.ok(withPopup.getPopup());
  assert.equal(styled.options.strokeWidth, 4);
  assert.equal(styled.options.strokeOpacity, 0.8);
  for (const layer of [tiles, line, area, data, withPopup, styled]) assert.equal(map.hasLayer(layer), true);

  map.destroy();
});
