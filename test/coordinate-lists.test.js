import assert from "node:assert/strict";
import test from "node:test";
import { latLngs, lngLats, fromGeoJSONPositions } from "../dist/geo.js";

const plain = (points) => points.map((point) => [point.lat, point.lng]);

test("latLngs reads pairs latitude first", () => {
  assert.deepEqual(
    plain(latLngs([[55.75, 37.62], [59.94, 30.31]])),
    [[55.75, 37.62], [59.94, 30.31]]
  );
});

test("lngLats reads the same pairs longitude first", () => {
  assert.deepEqual(
    plain(lngLats([[37.62, 55.75], [30.31, 59.94]])),
    [[55.75, 37.62], [59.94, 30.31]]
  );
});

test("a flat run of numbers means the same list, in the same order", () => {
  assert.deepEqual(
    plain(latLngs([55.75, 37.62, 59.94, 30.31])),
    plain(latLngs([[55.75, 37.62], [59.94, 30.31]]))
  );
  assert.deepEqual(
    plain(lngLats([37.62, 55.75, 30.31, 59.94])),
    plain(lngLats([[37.62, 55.75], [30.31, 59.94]]))
  );
});

test("typed arrays are read without building intermediate pairs", () => {
  const packed = Float64Array.of(55.75, 37.62, 59.94, 30.31);
  assert.deepEqual(plain(latLngs(packed)), [[55.75, 37.62], [59.94, 30.31]]);
});

test("an odd flat length is a dropped number, not a shifted route", () => {
  assert.throws(() => latLngs([55.75, 37.62, 59.94]), /even number of values, got 3/);
});

test("a pair that is not a pair names the item that is wrong", () => {
  assert.throws(() => latLngs([[55.75, 37.62], [59.94]]), /item 1 is not a \[latitude, longitude\] pair/);
  assert.throws(() => lngLats([[37.62, 55.75], 30.31]), /item 1 is not a \[longitude, latitude\] pair/);
});

test("non-finite values are rejected in both shapes", () => {
  assert.throws(() => latLngs([[55.75, Number.NaN]]), /finite/);
  assert.throws(() => latLngs([55.75, Number.POSITIVE_INFINITY]), /finite/);
});

test("an empty list is empty, not an error", () => {
  assert.deepEqual(latLngs([]), []);
  assert.deepEqual(lngLats([]), []);
  assert.deepEqual(fromGeoJSONPositions([]), []);
});

test("something that is not a list is rejected by name", () => {
  assert.throws(() => latLngs(null), /latLngs requires an array/);
  assert.throws(() => lngLats({ lat: 1, lng: 2 }), /lngLats requires an array/);
});

test("fromGeoJSONPositions takes a coordinates array and ignores altitude", () => {
  const ring = [[37.62, 55.75, 140], [30.31, 59.94, 3], [44.00, 56.33]];
  assert.deepEqual(plain(fromGeoJSONPositions(ring)), [[55.75, 37.62], [59.94, 30.31], [56.33, 44.00]]);
});

test("the converted list is what the layers already accept", async () => {
  const { LatLng } = await import("../dist/geo.js");
  for (const value of latLngs([55.75, 37.62, 59.94, 30.31])) {
    assert.ok(value instanceof LatLng);
    assert.ok(Object.isFrozen(value));
  }
});
