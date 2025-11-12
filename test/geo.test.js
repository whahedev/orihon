import test from "node:test";
import assert from "node:assert/strict";
import { destination, distance, geodesicInterpolate, metersToPixels, project, unproject, wrapLng } from "../dist/geo.js";

test("project/unproject roundtrip stays close", () => {
  const source = { lat: 52.520008, lng: 13.404954 };
  const point = project(source, 12);
  const actual = unproject(point, 12);
  assert.ok(Math.abs(actual.lat - source.lat) < 1e-9);
  assert.ok(Math.abs(actual.lng - source.lng) < 1e-9);
});

test("wrapLng normalizes longitudes", () => {
  assert.equal(wrapLng(181), -179);
  assert.equal(wrapLng(-181), 179);
});

test("distance returns meters", () => {
  const meters = distance([52.520008, 13.404954], [53.551086, 9.993682]);
  assert.ok(meters > 250000 && meters < 270000);
});

test("metersToPixels accounts for latitude", () => {
  const equator = metersToPixels(1000, 0, 10);
  const latitude60 = metersToPixels(1000, 60, 10);
  assert.ok(Math.abs(latitude60 / equator - 2) < 1e-9);
});

test("destination and geodesic interpolation follow a great circle", () => {
  const east = destination([0, 0], 111_319.49, 90);
  assert.ok(Math.abs(east.lat) < 1e-6);
  assert.ok(Math.abs(east.lng - 1) < 1e-5);
  const points = geodesicInterpolate([0, 0], [0, 3], 100_000);
  assert.ok(points.length >= 5);
  assert.ok(points.at(-1).equals([0, 3]));
});
