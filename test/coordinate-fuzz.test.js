import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LAT,
  bounds,
  clampLat,
  distance,
  project,
  unproject,
  wrapLng
} from "../dist/geo.js";

function randomSource(seed = 0x41e20) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("projection round trips deterministic fuzz coordinates", () => {
  const random = randomSource();
  for (let index = 0; index < 20_000; index += 1) {
    const lat = random() * 220 - 110;
    const lng = random() * 2160 - 1080;
    const zoom = random() * 24;
    const projected = project({ lat: lat, lng: lng }, zoom);
    const restored = unproject(projected, zoom);

    assert.equal(Number.isFinite(projected.x), true);
    assert.equal(Number.isFinite(projected.y), true);
    assert.ok(Math.abs(restored.lat - clampLat(lat)) < 1e-9, `latitude at sample ${index}`);
    assert.ok(Math.abs(restored.lng - wrapLng(lng)) < 1e-9, `longitude at sample ${index}`);
    assert.ok(Math.abs(restored.lat) <= MAX_LAT + 1e-9);
  }
});

test("distance and bounds invariants survive coordinate fuzzing", () => {
  const random = randomSource(0xa30f9);
  for (let index = 0; index < 10_000; index += 1) {
    const a = [random() * 170 - 85, random() * 360 - 180];
    const b = [random() * 170 - 85, random() * 360 - 180];
    const ab = distance({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });
    const ba = distance({ lat: b[0], lng: b[1] }, { lat: a[0], lng: a[1] });
    const area = bounds({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });

    assert.equal(Number.isFinite(ab), true);
    assert.ok(ab >= 0);
    assert.ok(Math.abs(ab - ba) < 1e-7);
    assert.equal(area.contains({ lat: a[0], lng: a[1] }), true);
    assert.equal(area.contains({ lat: b[0], lng: b[1] }), true);
    assert.ok(wrapLng(a[1]) >= -180 && wrapLng(a[1]) <= 180);
  }
});
