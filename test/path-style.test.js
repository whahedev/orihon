import test from "node:test";
import assert from "node:assert/strict";
import { CanvasPathBatch } from "../dist/layers/canvas-path-batch.js";
import { Circle, Polygon, Polyline, normalizeDashArray } from "../dist/layers/vector.js";

test("dash arrays accept strings, arrays and clearing values", () => {
  assert.deepEqual(normalizeDashArray("8 4"), [8, 4]);
  assert.deepEqual(normalizeDashArray([6, 2]), [6, 2]);
  assert.deepEqual(normalizeDashArray(null), []);
});

test("geodesic circle bounds widen in longitude at high latitude", () => {
  const geodesic = new Circle({ lat: 60, lng: 10 }, { radiusMeters: 50_000 }, { geodesic: true });
  const bounds = geodesic.getBounds();
  assert.ok(bounds.east - bounds.west > bounds.north - bounds.south);
});

test("polyline geodesic option remains mutable through setStyle", () => {
  const line = new Polyline([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }], { dashArray: "6 4", arrow: "end", geodesic: true });
  line.setStyle({ dashArray: null });
  assert.equal(line.options.dashArray, null);
  assert.equal(line.options.arrow, "end");
});

test("geodesic line and polygon bounds include great-circle bulges", () => {
  const line = new Polyline([{ lat: 60, lng: -60 }, { lat: 60, lng: 60 }], { geodesic: true });
  const area = new Polygon([{ lat: 60, lng: -60 }, { lat: 60, lng: 60 }, { lat: 20, lng: 0 }], { geodesic: true });
  assert.ok(line.getBounds().north > 60);
  assert.ok(area.getBounds().north > 60);
});

test("setStyle redraws when geodesic changes", () => {
  class CountingPolyline extends Polyline {
    renders = 0;
    render() { this.renders++; super.render(); }
  }
  const line = new CountingPolyline([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]);
  line.setStyle({ geodesic: true });
  assert.equal(line.renders, 1);
});

test("CanvasPathBatch densifies geodesic paths", () => {
  const batch = new CanvasPathBatch();
  batch.addPath([[{ lat: 60, lng: -60 }, { lat: 60, lng: 60 }]], false, { geodesic: true });
  assert.ok(batch.records[0].geodesicRings[0].lat.length > 2);
});

test("Circle uses map units for bounds on Simple CRS", () => {
  const shape = new Circle({ lat: 200, lng: 300 }, { radiusMapUnits: 50 }, { geodesic: true });
  shape.map = { crs: { code: "Simple" } };
  assert.deepEqual(shape.getBounds().getSouthWest().toArray(), [150, 250]);
  assert.deepEqual(shape.getBounds().getNorthEast().toArray(), [250, 350]);
});
