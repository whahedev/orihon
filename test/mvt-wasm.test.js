import test from "node:test";
import assert from "node:assert/strict";
import { decodePackedMVT } from "orihon/mvt";
import {
  decodeMvtGeometryWasm,
  decodePackedMVTWasm,
  mvtGeometryWasmSupported,
  mvtGeometryWasmError,
  createMVTWasmProvider
} from "orihon/mvt-wasm";

test("WASM MVT geometry decoder turns MoveTo into tile-local xy", () => {
  assert.equal(mvtGeometryWasmSupported(), true, mvtGeometryWasmError());
  const geom = decodeMvtGeometryWasm(Uint8Array.from(packed([9, 4096, 4096])));
  assert.ok(geom);
  assert.equal(geom.xy[0], 2048);
  assert.equal(geom.xy[1], 2048);
  assert.equal(geom.partEnds[0], 1);
});

test("decodePackedMVTWasm matches the JS packed decoder", () => {
  const bytes = makeMinimalMVT();
  const js = decodePackedMVT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  const wasm = decodePackedMVTWasm(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  assert.deepEqual([...wasm.layers[0].xy], [...js.layers[0].xy]);
  assert.equal(wasm.layers[0].types[0], 1);
  assert.equal(wasm.layers[0].ids[0], 7);
});

test("createMVTWasmProvider is a function", () => {
  assert.equal(typeof createMVTWasmProvider, "function");
});

test("decodePackedMVT from Advanced matches WASM geometry for Mapbox MVT", () => {
  const bytes = makeMinimalMVT();
  const packed = decodePackedMVT(bytes, { x: 0, y: 0, z: 0 }, { layer: "places" });
  assert.equal(packed.layers[0].xy[0], 2048);
  assert.equal(packed.layers[0].xy[1], 2048);
  assert.equal(packed.layers[0].types[0], 1);
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
