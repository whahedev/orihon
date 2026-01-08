import assert from "node:assert/strict";
import test from "node:test";

import { buildAdaptiveIsolinesFromField, selectAdaptiveIsolineLevels } from "../dist/services/adaptive-isoline-levels.js";

function heterogeneousField(cols = 160, rows = 100) {
  const grid = new Float32Array(cols * rows);
  const hills = [
    [34, 55, 30, 0.42],
    [91, 48, 22, 0.85],
    [136, 44, 7, 6.5],
    [78, 82, 12, 0.58]
  ];
  let peak = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let value = 0;
    for (const [cx, cy, sigma, amplitude] of hills) {
      const dx = x - cx, dy = y - cy;
      value += amplitude * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
    grid[y * cols + x] = value;
    peak = Math.max(peak, value);
  }
  return { grid, cols, rows, peak, westMerc: 0.4, northMerc: 0.3, widthMerc: 0.2, heightMerc: 0.15, kernelMerc: 0.001 };
}

test("adaptive levels cover more heterogeneous territory than uniform values", () => {
  const field = heterogeneousField();
  const selection = selectAdaptiveIsolineLevels(field.grid, field.cols, field.rows, {
    levels: 6,
    candidateMultiplier: 12,
    coverageRadius: 1
  });
  assert.equal(selection.thresholds.length, 6);
  assert.ok(selection.coverage > selection.uniformCoverage,
    `adaptive ${selection.coverage} must exceed uniform ${selection.uniformCoverage}`);
  assert.ok(selection.selected.every((item) => item.lengthCells > 0 && item.gain >= 0));
  assert.ok(Number.isFinite(selection.distributionVariance));
  assert.ok(Number.isFinite(selection.score));
  assert.ok(selection.range[1] < field.peak, "robust range should suppress the isolated extreme peak");
  const normalized = selection.thresholds.map((level) => (level - selection.range[0]) / (selection.range[1] - selection.range[0]));
  assert.ok(normalized.some((value) => value < 1 / 3));
  assert.ok(normalized.some((value) => value >= 1 / 3 && value < 2 / 3));
  assert.ok(normalized.some((value) => value >= 2 / 3));
});

test("pipeline output reports adaptive coverage and ring geometry metrics", () => {
  const field = heterogeneousField();
  const contours = buildAdaptiveIsolinesFromField(field, { levels: 5, useWasm: true });
  assert.ok(contours.rings.length > 0);
  assert.ok(contours.levelSelection?.coverage > contours.levelSelection?.uniformCoverage);
  assert.ok(contours.rings.every((ring) => Number.isFinite(ring.gridLength) && ring.gridLength > 0));
  assert.ok(contours.rings.some((ring) => (ring.gridArea ?? 0) > 0));
});

test("valid mask excludes NoData cells and forces mask-aware marching", () => {
  const field = heterogeneousField(80, 60);
  const mask = new Uint8Array(field.cols * field.rows);
  for (let y = 0; y < field.rows; y++) for (let x = 0; x < field.cols / 2; x++) mask[y * field.cols + x] = 1;
  const selection = selectAdaptiveIsolineLevels(field.grid, field.cols, field.rows, { levels: 4, validMask: mask });
  assert.ok(selection.validZones > 0);
  const result = buildAdaptiveIsolinesFromField(field, {
    levels: 4,
    validMask: mask,
    useWasm: true,
    minIsolineLength: 2
  });
  assert.equal(result.wasm, false);
  assert.ok(result.rings.every((ring) => (ring.gridLength ?? 0) >= 2));
});
