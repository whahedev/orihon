import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { decodePackedMVTJs } from "../dist/layers/mvt.js";
import {
  decodePackedMVTFeatureWasm,
  decodePackedMVTWasm,
  mvtGeometryWasmSupported,
  mvtTileWasmSupported
} from "../dist/layers/mvt-wasm.js";
import { decodePackedMVTTileWasmUnsafe } from "../dist/layers/mvt-tile-wasm.js";

const encoder = new TextEncoder();
const tileCoord = {
  x: Number(process.env.TILE_X || 1204),
  y: Number(process.env.TILE_Y || 1539),
  z: Number(process.env.TILE_Z || 12)
};
const external = process.env.MVT_FILE;
const forcedCount = process.env.COUNT ? Number(process.env.COUNT) : null;
const forcedVerts = process.env.VERTS ? Number(process.env.VERTS) : null;
const forcedRuns = process.env.RUNS ? Number(process.env.RUNS) : null;

console.log(`Orihon MVT-P1 self-describing blob benchmark · Node ${process.version} · ${process.platform}/${process.arch}`);
console.log(`geometry WASM=${mvtGeometryWasmSupported()} · tile WASM=${mvtTileWasmSupported()} · --expose-gc=${typeof global.gc === "function"}`);

if (external) {
  const bytes = new Uint8Array(fs.readFileSync(external));
  runCase({ name: "external", bytes, expectedFeatures: null, runs: forcedRuns || 7 });
} else if (forcedCount != null) {
  const count = forcedCount;
  const verts = Math.max(2, forcedVerts || 8);
  runCase({ name: `custom ${fmt(count)} features × ${verts} verts`, bytes: makeSyntheticTile(count, verts), expectedFeatures: count, runs: forcedRuns || (count >= 10000 ? 3 : 7) });
} else {
  const matrix = [
    ["overhead / small", 100, 2, 11],
    ["compute / complex", 500, 64, 7],
    ["feature churn", 5000, 2, 5],
    ["heavy complex", 2000, 64, 5],
    ["worst churn", 15000, 2, 3]
  ];
  for (const [name, count, verts, runs] of matrix) {
    runCase({ name, bytes: makeSyntheticTile(count, verts), expectedFeatures: count, runs: forcedRuns || runs });
  }
}

const fallbackRuns = Number(process.env.FALLBACK_RUNS || 0);
if (fallbackRuns > 0) {
  const count = forcedCount || 5000;
  const verts = Math.max(2, forcedVerts || 2);
  const bytes = external ? new Uint8Array(fs.readFileSync(external)) : makeSyntheticTile(count, verts);
  const options = optionsFor(bytes, count);
  let failed = 0;
  global.gc?.();
  const t0 = performance.now();
  for (let i = 0; i < fallbackRuns; i++) {
    if (!decodePackedMVTWasm(bytes, tileCoord, options)) failed++;
  }
  const ms = performance.now() - t0;
  console.log(`\nFallback soak: ${fmt(fallbackRuns)} tiles · fallback=${fmt(failed)} (${(failed * 100 / fallbackRuns).toFixed(4)}%) · ${(ms / fallbackRuns).toFixed(3)}ms/tile`);
}

function runCase({ name, bytes, expectedFeatures, runs }) {
  const options = optionsFor(bytes, expectedFeatures || 16384);
  console.log(`\n=== ${name} ===`);
  console.log(`PBF=${fmt(bytes.byteLength)} bytes · expected features=${expectedFeatures == null ? "unknown" : fmt(expectedFeatures)} · runs=${runs}`);

  const decoders = [
    ["JS packed", (b, t, o) => decodePackedMVTJs(b, t, o)],
    ["feature-WASM", (b, t, o) => decodePackedMVTFeatureWasm(b, t, o)],
    ["tile-WASM snapshot", (b, t, o) => decodePackedMVTWasm(b, t, o)],
    ["tile-WASM unsafe", (b, t, o) => decodePackedMVTTileWasmUnsafe(b, t, o)]
  ];

  const reference = decodePackedMVTJs(bytes, tileCoord, options);
  const referenceSig = signature(reference);
  for (const [decoderName, fn] of decoders.slice(1)) {
    const got = fn(bytes, tileCoord, options);
    const ok = got != null && signature(got) === referenceSig;
    console.log(`semantic ${decoderName.padEnd(18)} ${ok ? "PASS" : "FAIL"}`);
    if (!ok) process.exitCode = 1;
  }

  console.log("warm packed decode:");
  const timings = new Map();
  for (const [decoderName, fn] of decoders) {
    for (let i = 0; i < 2; i++) fn(bytes, tileCoord, options);
    global.gc?.();
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const result = fn(bytes, tileCoord, options);
      if (!result) throw new Error(`${decoderName} returned null`);
      times.push(performance.now() - t0);
    }
    const s = stats(times);
    timings.set(decoderName, s.median);
    console.log(`  ${decoderName.padEnd(20)} ${s.median.toFixed(3)}ms median · ${s.p95.toFixed(3)}ms p95`);
  }

  const snapshotMedian = timings.get("tile-WASM snapshot");
  const unsafeMedian = timings.get("tile-WASM unsafe");
  const jsMedian = timings.get("JS packed");
  const featureMedian = timings.get("feature-WASM");
  console.log(`  speedup snapshot vs JS       ${(jsMedian / snapshotMedian).toFixed(2)}x`);
  console.log(`  speedup snapshot vs feature  ${(featureMedian / snapshotMedian).toFixed(2)}x`);
  console.log(`  snapshot tax (median delta)  ${(snapshotMedian - unsafeMedian).toFixed(3)}ms`);

  const stableProfile = {};
  global.gc?.();
  decodePackedMVTWasm(bytes, tileCoord, { ...options, __mvtTileWasmProfile: stableProfile });
  printProfile("snapshot", stableProfile);

  const unsafeProfile = {};
  global.gc?.();
  decodePackedMVTTileWasmUnsafe(bytes, tileCoord, { ...options, __mvtTileWasmProfile: unsafeProfile });
  printProfile("unsafe", unsafeProfile);
}

function printProfile(label, profile) {
  console.log(`${label} profile:`);
  const rows = [
    ["input", "inputBytes", "bytes"],
    ["allocated blob", "outputBytes", "bytes"],
    ["live blob payload", "liveBytes", "bytes"],
    ["arena waste", "arenaWasteBytes", "bytes"],
    ["arena blob/live", "arenaWasteRatio", "ratio"],
    ["layers", "layers", ""],
    ["features", "features", ""],
    ["capacity retries", "retries", ""],
    ["module/load", "loadMs", "ms"],
    ["memory/grow", "memoryMs", "ms"],
    ["JS → WASM copy", "inputCopyMs", "ms"],
    ["WASM exact decode", "wasmMs", "ms"],
    ["WASM → snapshot", "outputCopyMs", "ms"],
    ["metadata + views", "metadataMs", "ms"],
    ["total profiled", "totalMs", "ms"]
  ];
  for (const [name, key, unit] of rows) {
    const v = profile[key] ?? 0;
    let shown;
    if (unit === "ms") shown = Number(v).toFixed(3);
    else if (unit === "ratio") shown = Number(v).toFixed(2) + "x";
    else shown = fmt(v);
    console.log(`  ${name.padEnd(24)} ${shown}${unit === "bytes" ? " bytes" : unit === "ms" ? "ms" : ""}`);
  }
}

function optionsFor(bytes, count) {
  return {
    maxBytes: Math.max(2_097_152, bytes.byteLength + 1024),
    maxFeatures: Math.max(16_384, Number(count || 0) + 1024)
  };
}
function stats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] };
}
function fmt(value) { return Number(value).toLocaleString("en-US"); }
function signature(tile) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([tile.x, tile.y, tile.z]));
  for (const layer of tile.layers) {
    hash.update(JSON.stringify([layer.name, layer.extent, layer.keys, layer.values, layer.ids]));
    for (const arr of [layer.xy, layer.types, layer.vertexOffsets, layer.partOffsets, layer.partEnds, layer.tagOffsets, layer.tags]) {
      hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    }
  }
  return hash.digest("hex");
}
function varint(value) {
  let n = BigInt(value); const out = [];
  while (n > 0x7fn) { out.push(Number((n & 0x7fn) | 0x80n)); n >>= 7n; }
  out.push(Number(n)); return out;
}
function key(field, wire) { return varint((field << 3) | wire); }
function bytesField(field, data) { return [...key(field, 2), ...varint(data.length), ...data]; }
function varintField(field, value) { return [...key(field, 0), ...varint(value)]; }
function zz(v) { return v < 0 ? (-v * 2 - 1) >>> 0 : (v * 2) >>> 0; }
function makeGeometry(seed, vertices, close) {
  let x = (seed * 17) & 4095, y = (seed * 29) & 4095;
  const out = [9, ...varint(zz(x)), ...varint(zz(y))];
  if (vertices > 1) {
    out.push(...varint(((vertices - 1) << 3) | 2));
    for (let i = 1; i < vertices; i++) {
      const nx = (x + 7 + (seed + i) % 31) & 4095;
      const ny = (y + 5 + (seed * 3 + i) % 23) & 4095;
      out.push(...varint(zz(nx - x)), ...varint(zz(ny - y)));
      x = nx; y = ny;
    }
  }
  if (close) out.push(15);
  return out;
}
function feature(id, type, geom, tags) {
  return [
    ...varintField(1, id),
    ...bytesField(2, tags.flatMap(varint)),
    ...varintField(3, type),
    ...bytesField(4, geom)
  ];
}
function valueString(v) { return bytesField(1, [...encoder.encode(v)]); }
function valueNumber(v) { return varintField(4, v); }
function valueBool(v) { return varintField(6, v ? 1 : 0); }
function makeLayer(name, startId, count, vertices) {
  const out = [...bytesField(1, [...encoder.encode(name)])];
  for (let i = 0; i < count; i++) {
    const n = startId + i;
    const kind = n % 10;
    const type = kind < 3 ? 1 : kind < 8 ? 2 : 3;
    const points = type === 1 ? 1 : vertices;
    out.push(...bytesField(2, feature(n + 1, type, makeGeometry(n, points, type === 3), [0, 0, 1, 1, 2, 2])));
  }
  for (const k of ["class", "rank", "active"]) out.push(...bytesField(3, [...encoder.encode(k)]));
  for (const v of [valueString(name), valueNumber(7), valueBool(true)]) out.push(...bytesField(4, v));
  out.push(...varintField(5, 4096), ...varintField(15, 2));
  return out;
}
function makeSyntheticTile(count, vertices) {
  const a = Math.floor(count * 0.5), b = Math.floor(count * 0.3), c = count - a - b;
  return Uint8Array.from([
    ...bytesField(3, makeLayer("roads", 0, a, vertices)),
    ...bytesField(3, makeLayer("buildings", a, b, Math.max(4, Math.floor(vertices / 2)))),
    ...bytesField(3, makeLayer("places", a + b, c, 2))
  ]);
}
