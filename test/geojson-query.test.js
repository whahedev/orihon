import test from "node:test";
import assert from "node:assert/strict";
import { GeoJSONLayer, Orihon, Point, WebGLPathBatch, latLng } from "../dist/full-entry.js";

/**
 * A map stub in `Simple`-like space: container x is longitude, y is latitude, so the expected hit
 * coordinates are readable in the test. It counts projections, which is how the bounding-box
 * short-circuit is observed — a rejected feature must never have its vertices projected.
 */
function stubMap() {
  const map = {
    projections: 0,
    crs: { code: "Simple" },
    latLngToContainerPoint(value) {
      map.projections += 1;
      return new Point(value[1] ?? value.lng, value[0] ?? value.lat);
    },
    containerPointToLatLng(value) {
      return latLng({ lat: value.y, lng: value.x });
    }
  };
  return map;
}

const QUERY = (layers) => ({ tolerance: 0, layers, pane: "", limit: 1 });

const SQUARE = {
  type: "Feature",
  id: "parcel-1",
  properties: { name: "area" },
  geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }
};

const LINE = {
  type: "Feature",
  id: "road-7",
  properties: { name: "road" },
  geometry: { type: "LineString", coordinates: [[0, 0], [10, 10]] }
};

test("an SVG GeoJSON path answers a query with its own feature", () => {
  // `GeoJSONPathLayer` extends `PathLayer`, which has no `queryHit`, so before this every line and
  // polygon a GeoJSON layer drew was invisible to `map.query()` however few features it held.
  const layer = new GeoJSONLayer(SQUARE).getLayers()[0];
  layer.map = stubMap();

  const inside = layer.queryHit(new Point(5, 5), QUERY([layer]));
  assert.equal(inside.source, "svg");
  assert.equal(inside.feature, SQUARE);
  assert.equal(inside.id, "parcel-1");
  assert.deepEqual([inside.latlng.lat, inside.latlng.lng], [5, 5]);

  assert.equal(layer.queryHit(new Point(50, 50), QUERY([layer])), null, "outside the ring is a miss");
});

test("an unfilled SVG polygon is hit on its stroke, not through its middle", () => {
  const layer = new GeoJSONLayer(SQUARE, { fill: "none" }).getLayers()[0];
  layer.map = stubMap();

  assert.equal(layer.queryHit(new Point(5, 5), QUERY([layer])), null);
  assert.ok(layer.queryHit(new Point(0, 5), QUERY([layer])), "the edge still answers");
});

test("an SVG line is hit near the stroke only", () => {
  const layer = new GeoJSONLayer(LINE).getLayers()[0];
  layer.map = stubMap();

  const hit = layer.queryHit(new Point(5, 5), QUERY([layer]));
  assert.equal(hit.id, "road-7");
  assert.equal(hit.feature, LINE);
  assert.equal(layer.queryHit(new Point(9, 1), QUERY([layer])), null);
});

test("a hole in an SVG polygon falls through", () => {
  const donut = {
    type: "Feature",
    id: "donut",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]
      ]
    }
  };
  const layer = new GeoJSONLayer(donut).getLayers()[0];
  layer.map = stubMap();

  assert.ok(layer.queryHit(new Point(1, 5), QUERY([layer])), "the ring itself is a hit");
  assert.equal(layer.queryHit(new Point(5, 5), QUERY([layer])), null, "the hole is not");
});

test("the canvas batch rejects on the bounding box before projecting a feature", () => {
  const ring = Array.from({ length: 400 }, (_, index) => [index / 100, index / 100]);
  ring.push(ring[0]);
  const far = {
    type: "Feature",
    id: "far-away",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] }
  };
  const batch = new GeoJSONLayer(far, { renderer: "canvas" }).getLayers()[0];
  const map = stubMap();
  batch.map = map;

  map.projections = 0;
  assert.equal(batch.queryHit(new Point(500, 500), QUERY([batch])), null);
  // Two corners of the stored box, not four hundred vertices.
  assert.equal(map.projections <= 4, true, `projected ${map.projections} points for a rejected record`);

  map.projections = 0;
  const hit = batch.queryHit(new Point(1, 1), QUERY([batch]));
  assert.equal(hit.feature, far);
  assert.equal(hit.id, "far-away", "canvas hits carry the feature id too");
  assert.equal(map.projections > 4, true, "a candidate is traced in full");
});

test("the WebGL batch hit-tests the paths it drew and carries the feature", () => {
  const batch = new WebGLPathBatch({ interactive: true });
  batch.addPath([[{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 }, { lat: 0, lng: 0 }]], true, { fill: "#2563eb" }, SQUARE);
  batch.map = stubMap();

  const hit = batch.queryHit(new Point(5, 5), QUERY([batch]));
  assert.equal(hit.source, "webgl");
  assert.equal(hit.feature, SQUARE);
  assert.equal(hit.id, "parcel-1");
  assert.equal(hit.index, 0);
  assert.equal(batch.queryHit(new Point(50, 50), QUERY([batch])), null);

  batch.clearPaths();
  assert.equal(batch.queryHit(new Point(5, 5), QUERY([batch])), null, "cleared paths answer nothing");
});

test("a non-interactive WebGL batch stays out of the query", () => {
  const batch = new WebGLPathBatch();
  assert.equal(batch.options.interactive, false, "the batch is a passive overlay by default");
  batch.addPath([[{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 0, lng: 0 }]], true, {}, SQUARE);
  batch.map = stubMap();
  assert.equal(batch.queryHit(new Point(5, 5), QUERY([batch])), null);
});

test("a GeoJSON layer in webgl mode hands its features to the batch", () => {
  // `registerGeoJSONWebGLBatch` runs on import of the Advanced entry, so this exercises the real
  // wiring rather than a hand-built batch.
  const layer = new GeoJSONLayer(SQUARE, { renderer: "webgl" });
  const batch = layer.getLayers()[0];
  assert.equal(batch instanceof WebGLPathBatch, true);
  batch.map = stubMap();

  const hit = batch.queryHit(new Point(5, 5), QUERY([batch]));
  assert.equal(hit.feature, SQUARE);
  assert.equal(hit.id, "parcel-1");
});

test("map.query reaches GeoJSON children through the layer walk", () => {
  const pane = {};
  const geo = new GeoJSONLayer(SQUARE);
  const child = geo.getLayers()[0];
  child.map = stubMap();
  child.getPane = () => pane;

  const map = { layers: new Set([child]), viewport: { children: [pane] } };
  const hits = Orihon.prototype.query.call(map, new Point(5, 5), { limit: Infinity });
  assert.equal(hits.length, 1, "one hit per feature, not one per renderer");
  assert.equal(hits[0].feature, SQUARE);
});
