import test from "node:test";
import assert from "node:assert/strict";
import { decodePackedMVTJs } from "../dist/layers/mvt.js";
import {
  decodePackedMVTFeatureWasm,
  decodePackedMVTWasm,
  mvtTileWasmSupported
} from "../dist/layers/mvt-wasm.js";
import { decodePackedMVTTileWasmUnsafe } from "../dist/layers/mvt-tile-wasm.js";

const encoder = new TextEncoder();
const tileCoord = { x: 1204, y: 1539, z: 12 };

function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n));
  return out;
}
function key(field, wire) { return varint((field << 3) | wire); }
function bytesField(field, bytes) { return [...key(field, 2), ...varint(bytes.length), ...bytes]; }
function varintField(field, value) { return [...key(field, 0), ...varint(value)]; }
function stringBytes(value) { return [...encoder.encode(value)]; }
function zigzag(value) { return value < 0 ? (-value * 2 - 1) >>> 0 : (value * 2) >>> 0; }
function packed(values) { return values.flatMap(varint); }
function geometry(points, close = false) {
  if (!points.length) return [];
  const out = [9];
  let x = 0, y = 0;
  out.push(...varint(zigzag(points[0][0] - x)), ...varint(zigzag(points[0][1] - y)));
  x = points[0][0]; y = points[0][1];
  if (points.length > 1) {
    out.push(...varint(((points.length - 1) << 3) | 2));
    for (let i = 1; i < points.length; i++) {
      const [nx, ny] = points[i];
      out.push(...varint(zigzag(nx - x)), ...varint(zigzag(ny - y)));
      x = nx; y = ny;
    }
  }
  if (close) out.push(15);
  return out;
}
function valueString(value) { return bytesField(1, stringBytes(value)); }
function valueNumber(value) { return varintField(4, value); }
function valueBool(value) { return varintField(6, value ? 1 : 0); }
function feature({ id, type, points, close = false, tags = [0, 0] }) {
  const out = [];
  if (id != null) out.push(...varintField(1, id));
  out.push(...bytesField(2, packed(tags)));
  out.push(...varintField(3, type));
  out.push(...bytesField(4, geometry(points, close)));
  return out;
}
function layer(name, features) {
  const keys = ["class", "rank", "active"];
  const values = [valueString("road"), valueNumber(7), valueBool(true)];
  const out = [...bytesField(1, stringBytes(name))];
  for (const item of features) out.push(...bytesField(2, item));
  for (const item of keys) out.push(...bytesField(3, stringBytes(item)));
  for (const item of values) out.push(...bytesField(4, item));
  out.push(...varintField(5, 4096), ...varintField(15, 2));
  return out;
}
function makeTile() {
  const roads = [
    feature({ id: 101, type: 1, points: [[40, 80]], tags: [0, 0] }),
    feature({ id: 102, type: 2, points: [[10, 10], [100, 30], [180, 90]], tags: [1, 1] }),
    feature({ id: 103, type: 3, points: [[0, 0], [100, 0], [100, 100], [0, 100]], close: true, tags: [2, 2] }),
    feature({ type: 1, points: [[8, 9]], tags: [0, 0, 1, 1] })
  ];
  const water = [
    feature({ id: 201, type: 3, points: [[200, 200], [300, 200], [300, 300], [200, 300]], close: true, tags: [0, 0] })
  ];
  return Uint8Array.from([
    ...bytesField(3, layer("roads", roads)),
    ...bytesField(3, layer("water", water))
  ]);
}
function makeMany(count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(feature({ id: i + 1, type: 2, points: [[i & 4095, (i * 3) & 4095], [(i + 7) & 4095, (i * 3 + 5) & 4095]], tags: [0, 0] }));
  }
  return Uint8Array.from(bytesField(3, layer("roads", items)));
}
function plain(packedTile) {
  return {
    x: packedTile.x,
    y: packedTile.y,
    z: packedTile.z,
    layers: packedTile.layers.map((layer) => ({
      name: layer.name,
      extent: layer.extent,
      keys: layer.keys,
      values: layer.values,
      xy: [...layer.xy],
      types: [...layer.types],
      ids: layer.ids,
      vertexOffsets: [...layer.vertexOffsets],
      partOffsets: [...layer.partOffsets],
      partEnds: [...layer.partEnds],
      tagOffsets: [...layer.tagOffsets],
      tags: [...layer.tags]
    }))
  };
}

test("MVT-P1 streaming tile WASM matches JS packed decoder", () => {
  assert.equal(mvtTileWasmSupported(), true);
  const bytes = makeTile();
  assert.deepEqual(plain(decodePackedMVTWasm(bytes, tileCoord)), plain(decodePackedMVTJs(bytes, tileCoord)));
});

test("MVT-P1 streaming tile WASM matches feature-level WASM baseline", () => {
  const bytes = makeTile();
  assert.deepEqual(plain(decodePackedMVTWasm(bytes, tileCoord)), plain(decodePackedMVTFeatureWasm(bytes, tileCoord)));
});

test("MVT-P1 unsafe live view has identical immediate semantics", () => {
  const bytes = makeTile();
  const unsafe = decodePackedMVTTileWasmUnsafe(bytes, tileCoord);
  assert.ok(unsafe);
  assert.deepEqual(plain(unsafe), plain(decodePackedMVTJs(bytes, tileCoord)));
});

test("MVT-P1 preserves global maxFeatures across layers", () => {
  const bytes = makeTile();
  const options = { maxFeatures: 3 };
  assert.deepEqual(plain(decodePackedMVTWasm(bytes, tileCoord, options)), plain(decodePackedMVTJs(bytes, tileCoord, options)));
});

test("MVT-P1 layer filter stays inside whole-tile WASM", () => {
  const bytes = makeTile();
  const profile = {};
  const wasm = decodePackedMVTWasm(bytes, tileCoord, { layer: "water", __mvtTileWasmProfile: profile });
  assert.deepEqual(plain(wasm), plain(decodePackedMVTJs(bytes, tileCoord, { layer: "water" })));
  assert.equal(profile.tileWasm, true);
  assert.deepEqual(wasm.layers.map((item) => item.name), ["water"]);
});

test("MVT-P1 stable snapshot survives input mutation and subsequent decodes", () => {
  const bytes = makeTile();
  const first = decodePackedMVTWasm(bytes, tileCoord);
  const before = plain(first);
  bytes.fill(0);
  for (let i = 0; i < 8; i++) decodePackedMVTWasm(makeTile(), { x: i, y: i + 1, z: 8 });
  assert.deepEqual(plain(first), before);
});

test("MVT-P1 profile exposes growable-arena allocation and live payload", () => {
  const profile = {};
  const bytes = makeMany(1000);
  const result = decodePackedMVTWasm(bytes, tileCoord, {
    maxBytes: bytes.byteLength + 1024,
    maxFeatures: 2000,
    __mvtTileWasmProfile: profile
  });
  assert.ok(result.layers.length > 0);
  assert.equal(profile.tileWasm, true);
  assert.equal(profile.snapshot, true);
  assert.ok(profile.outputBytes >= profile.liveBytes);
  assert.ok(profile.arenaWasteBytes >= 0);
  assert.ok(profile.arenaWasteRatio >= 1);
  assert.ok(profile.retries >= 0);
});

test("MVT-P1 oversized tile keeps existing empty-result contract", () => {
  const result = decodePackedMVTWasm(makeTile(), tileCoord, { maxBytes: 1 });
  assert.deepEqual(result.layers, []);
});
