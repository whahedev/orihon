import test from "node:test";
import assert from "node:assert/strict";
import * as Orihon from "../dist/index.js";
import * as Core from "../dist/core.js";
import * as Geo from "../dist/geo-entry.js";

test("GeoJSON conversion is explicit, longitude-first and available in each geo entry", () => {
  const source = Object.freeze([37.618423, 55.751244, 150]);
  for (const api of [Orihon, Core, Geo]) {
    const point = api.fromGeoJSONPosition(source);
    assert.equal(point.lat, 55.751244);
    assert.equal(point.lng, 37.618423);
    assert.deepEqual(api.toGeoJSONPosition(point), [37.618423, 55.751244]);
    const result = api.toGeoJSONPosition(point);
    result[0] = 0;
    assert.equal(point.lng, 37.618423);
  }
  assert.ok(Orihon.marker(Orihon.fromGeoJSONPosition(source)).getLatLng().equals({ lat: 55.751244, lng: 37.618423 }));
});

test("geographic APIs reject bare tuples instead of guessing their order", () => {
  const tuple = [37.618423, 55.751244];
  for (const operation of [
    () => Orihon.latLng(tuple),
    () => Orihon.marker(tuple),
    () => Orihon.marker({ lat: 0, lng: 0 }).setLatLng(tuple),
    () => Orihon.project(tuple, 10),
    () => Orihon.distance(tuple, { lat: 0, lng: 0 }),
    () => Orihon.bounds([tuple, tuple]),
    () => Orihon.polygon([[tuple, tuple, tuple]]),
    () => Orihon.webglPointLayer([tuple]),
    () => Orihon.preparePointBatch([tuple])
  ]) assert.throws(operation, /Coordinate tuples|finite numeric/);
});

test("invalid named and GeoJSON positions fail at the boundary", () => {
  for (const value of [null, {}, { lat: NaN, lng: 0 }, { lat: 0, lng: Infinity }, { lat: "1", lng: 2 }]) {
    assert.throws(() => Orihon.latLng(value), TypeError);
  }
  for (const value of [null, [], [1], [NaN, 2], [1, Infinity], ["1", 2]]) {
    assert.throws(() => Orihon.fromGeoJSONPosition(value), /finite numbers/);
  }
});

test("ObjectManager rejects tuples before mutating either normal or mass-point stores", async () => {
  for (const sceneFeatures of [true, false]) {
    const manager = Orihon.objectManager({ sceneFeatures });
    const original = { id: "a", coordinates: { lat: 55, lng: 37 } };
    manager.add(original);
    const invalid = { id: "a", coordinates: [37, 55] };
    assert.throws(() => manager.add(invalid), /coordinates: \{ lat, lng \}/);
    assert.throws(() => manager.update(invalid, { animate: true }), /coordinates: \{ lat, lng \}/);
    await assert.rejects(manager.addAsync([invalid]), /coordinates: \{ lat, lng \}/);
    assert.deepEqual(manager.getObject("a"), original);
    assert.equal(manager.getStats().objects, 1);
    manager.add({ id: "geojson", geometry: { type: "Point", coordinates: [37, 55] } });
    assert.equal(manager.getStats().objects, 2);
    manager.destroy();
  }
});

test("nested polygon rings and GeoJSON round-trip retain coordinate order", () => {
  const ring = [{ lat: 55, lng: 37 }, { lat: 56, lng: 37 }, { lat: 55, lng: 38 }];
  const polygon = Orihon.polygon([ring]);
  assert.equal(polygon.getBounds().toBBoxString(), "37,55,38,56");
  assert.deepEqual(Orihon.toGeoJSONPosition(polygon.getLatLngs()[0][0]), [37, 55]);
});
