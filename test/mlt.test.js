import test from "node:test";
import assert from "node:assert/strict";
import { decodePackedMVT, packedToGeoJSON } from "orihon/mvt";
import { decodePackedMLT, encodePackedMLT, decodeMLT, createMLTProvider, looksLikeMLT } from "orihon/mlt";

test("encodePackedMLT round-trips a packed point tile", () => {
  const packed = decodePackedMVT(makeMinimalMVT(), { x: 0, y: 0, z: 0 }, { layer: "places" });
  const bytes = encodePackedMLT(packed);
  const decoded = decodePackedMLT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  assert.equal(decoded.layers.length, 1);
  assert.equal(decoded.layers[0].name, "places");
  assert.equal(decoded.layers[0].types[0], 1);
  assert.equal(decoded.layers[0].xy[0], 2048);
  assert.equal(decoded.layers[0].xy[1], 2048);
  const features = packedToGeoJSON(decoded);
  assert.equal(features[0].properties.name, "Center");
  assert.equal(features[0].geometry.type, "Point");
});

test("decodeMLT honors maxBytes", () => {
  const packed = decodePackedMVT(makeMinimalMVT(), { x: 0, y: 0, z: 0 });
  const bytes = encodePackedMLT(packed);
  assert.equal(decodeMLT(bytes, { x: 0, y: 0, z: 0 }, { maxBytes: 1 }).length, 0);
});

test("createMLTProvider is a function", () => {
  assert.equal(typeof createMLTProvider, "function");
});

test("decodePackedMVT from Advanced accepts MLT bytes", () => {
  const packed = decodePackedMVT(makeMinimalMVT(), { x: 0, y: 0, z: 0 }, { layer: "places" });
  const bytes = encodePackedMLT(packed);
  const decoded = decodePackedMVT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  assert.equal(decoded.layers.length, 1);
  assert.equal(decoded.layers[0].name, "places");
  assert.equal(decoded.layers[0].xy[0], 2048);
  assert.equal(decoded.layers[0].xy[1], 2048);
});

test("looksLikeMLT rejects Mapbox MVT", () => {
  const mvt = makeMinimalMVT();
  assert.equal(looksLikeMLT(mvt), false);
  const packed = decodePackedMVT(mvt, { x: 0, y: 0, z: 0 });
  assert.equal(looksLikeMLT(encodePackedMLT(packed)), true);
});

function makeMinimalMVT() {
  const value = message([
    fieldBytes(1, stringBytes("Center"))
  ]);
  const feature = message([
    fieldVarint(1, 7),
    fieldBytes(2, packed([0, 0])),
    fieldVarint(3, 1),
    fieldBytes(4, packed([9, 4096, 4096]))
  ]);
  const layer = message([
    fieldVarint(15, 2),
    fieldBytes(1, stringBytes("places")),
    fieldBytes(2, feature),
    fieldBytes(3, stringBytes("name")),
    fieldBytes(4, value),
    fieldVarint(5, 4096)
  ]);
  return message([fieldBytes(3, layer)]);
}

function message(parts) {
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

function fieldVarint(field, value) {
  return new Uint8Array([...varint((field << 3) | 0), ...varint(value)]);
}

function fieldBytes(field, bytes) {
  return new Uint8Array([...varint((field << 3) | 2), ...varint(bytes.length), ...bytes]);
}

function packed(values) {
  return new Uint8Array(values.flatMap((value) => [...varint(value)]));
}

function stringBytes(value) {
  return new TextEncoder().encode(value);
}

function varint(value) {
  const result = [];
  let next = value;
  while (next > 0x7f) {
    result.push((next & 0x7f) | 0x80);
    next = Math.floor(next / 128);
  }
  result.push(next);
  return result;
}
