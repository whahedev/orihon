import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHeatContoursWasm,
  buildHeatContoursWasmUnsafe,
  heatContoursWasmSupported
} from "../dist/services/heat-isolines-wasm.js";
import { buildHeatFieldGrid, buildHeatIsolines } from "../dist/services/heat-isolines.js";

test("heat isolines WASM is available", () => {
  assert.equal(heatContoursWasmSupported(), true);
});

test("WASM stitches a closed hill into one line", () => {
  const grid = Float32Array.from([
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0
  ]);
  const out = buildHeatContoursWasm(grid, 4, 4, [0.5]);
  assert.ok(out);
  assert.equal(out.lineCount, 1);
  assert.equal(out.vertexCount, 9);
  assert.deepEqual([...out.lineOffsets], [0, 9]);
  assert.equal(out.xy[0], out.xy[(out.vertexCount - 1) * 2]);
  assert.equal(out.xy[1], out.xy[(out.vertexCount - 1) * 2 + 1]);
});

test("WASM preserves saddle topology", () => {
  const a = buildHeatContoursWasm(Float32Array.from([0, 1, 1, 0]), 2, 2, [0.5]);
  const b = buildHeatContoursWasm(Float32Array.from([1, 0, 0, 1]), 2, 2, [0.5]);
  assert.ok(a && b);
  assert.equal(a.lineCount, 2);
  assert.equal(a.vertexCount, 4);
  assert.equal(b.lineCount, 2);
  assert.equal(b.vertexCount, 4);
});


test("WASM handles contours that meet exactly at a grid vertex", () => {
  const grid = Float32Array.from([
    1, 0, 1,
    0, 0.5, 0,
    1, 0, 1
  ]);
  const out = buildHeatContoursWasm(grid, 3, 3, [0.5]);
  assert.ok(out);
  assert.equal(out.lineCount, 5);
  assert.equal(out.vertexCount, 13);
});

test("stable snapshot survives later WASM builds", () => {
  const grid = Float32Array.from([
    0, 0, 0, 0,
    0, 1, 1, 0,
    0, 1, 1, 0,
    0, 0, 0, 0
  ]);
  const first = buildHeatContoursWasm(grid, 4, 4, [0.5]);
  assert.ok(first);
  const before = [...first.xy];
  const noisy = new Float32Array(64 * 64);
  for (let i = 0; i < noisy.length; i++) noisy[i] = ((i * 1103515245 + 12345) >>> 8) / 0x00ffffff;
  assert.ok(buildHeatContoursWasmUnsafe(noisy, 64, 64, [0.2, 0.4, 0.6, 0.8]));
  assert.deepEqual([...first.xy], before);
});

test("world heat field is invariant to current zoom when scaleZoom is fixed", () => {
  const points = [
    [55.75, 37.61, 0.9],
    [55.76, 37.62, 0.4],
    [55.72, 37.58, 0.7],
    [55.79, 37.66, 0.2]
  ];
  const bounds = [[55.65, 37.45], [55.9, 37.8]];
  const a = buildHeatFieldGrid(points, bounds, { cols: 96, rows: 72, radius: 22, blur: 12, scaleZoom: 6, zoom: 6 });
  const b = buildHeatFieldGrid(points, bounds, { cols: 96, rows: 72, radius: 22, blur: 12, scaleZoom: 6, zoom: 10 });
  assert.ok(a && b);
  assert.equal(a.peak, b.peak);
  assert.deepEqual([...a.grid], [...b.grid]);
});

test("fixed referenceMax keeps contour values stable across zoom", () => {
  const points = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    points.push([55.70 + y * 0.01, 37.52 + x * 0.012, 0.9]);
  }
  const bounds = [[55.65, 37.45], [55.85, 37.75]];
  const opts = { cols: 96, rows: 72, radius: 20, blur: 10, scaleZoom: 6, referenceMax: 1, levels: [0.2, 0.4, 0.6] };
  const a = buildHeatIsolines(points, bounds, { ...opts, zoom: 6 });
  const b = buildHeatIsolines(points, bounds, { ...opts, zoom: 9 });
  assert.equal(a.wasm, true);
  assert.equal(b.wasm, true);
  assert.deepEqual([...new Set(a.rings.map((r) => r.value))], [...new Set(b.rings.map((r) => r.value))]);
});
