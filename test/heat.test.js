import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHeatFieldCpu,
  buildHeatFieldJs,
  createHeatFieldRequest,
  packHeatPoints,
  packHeatPointsAsync,
  packedHeatLatLngBounds
} from "../dist/services/heat-field.js";
import { heatFieldWasmSupported } from "../dist/services/heat-field-wasm.js";
import {
  buildHeat,
  buildPackedHeat
} from "../dist/services/heat.js";
import { heatFieldWebGpuAvailable } from "../dist/services/heat-field-webgpu.js";
import { heatLayer } from "../dist/layers/heat.js";
import { objectManager } from "../dist/services/object-manager.js";

function densePoints(count = 500) {
  const points = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 18;
    const radius = 0.02 + (i % 31) * 0.0015;
    points.push([50.08 + Math.sin(angle) * radius, 14.42 + Math.cos(angle) * radius, 0.5 + (i % 7) / 7]);
  }
  return points;
}

function regionalPacked(count) {
  const centers = [[52.52, 13.405], [48.8566, 2.3522], [51.5074, -0.1278], [41.9028, 12.4964], [50.0755, 14.4378], [59.3293, 18.0686], [40.4168, -3.7038]];
  const data = new Float32Array(count * 3);
  let seed = 0x9e3779b9;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  const mercator = (lat, lng) => {
    const x = (lng + 180) / 360;
    const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
    return [x, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
  };
  for (let i = 0; i < count; i++) {
    const cluster = i % centers.length;
    const center = centers[cluster];
    const r = Math.sqrt(random()) * (0.9 + cluster * 0.12);
    const angle = random() * Math.PI * 2;
    const [mx, my] = mercator(center[0] + Math.sin(angle) * r, center[1] + Math.cos(angle) * r);
    const offset = i * 3;
    data[offset] = mx;
    data[offset + 1] = my;
    data[offset + 2] = 0.4 + random() * 0.6;
  }
  return { data, count };
}

test("WASM scalar field tracks the reference JS field", () => {
  assert.equal(heatFieldWasmSupported(), true);
  const packed = packHeatPoints(densePoints());
  const request = createHeatFieldRequest(packed, [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
    cols: 128,
    rows: 96,
    radius: 28,
    blur: 16,
    scaleZoom: 8,
    zoom: 8
  });
  assert.ok(request);
  assert.ok(Math.abs(request.kernelMerc - 44 / (256 * 2 ** 8)) < 1e-12);
  const reference = buildHeatFieldJs(request);
  const wasm = buildHeatFieldCpu(request, "wasm");
  assert.equal(wasm.backend, "wasm");
  assert.equal(wasm.grid.length, reference.grid.length);
  let meanError = 0;
  let maxError = 0;
  for (let i = 0; i < wasm.grid.length; i++) {
    const error = Math.abs(wasm.grid[i] - reference.grid[i]);
    meanError += error;
    maxError = Math.max(maxError, error);
  }
  meanError /= wasm.grid.length;
  assert.ok(meanError < Math.max(1e-4, reference.peak * 2e-5), `mean error ${meanError}`);
  assert.ok(maxError < Math.max(0.02, reference.peak * 5e-4), `max error ${maxError}`);
});

test("async heat packing yields progress and swaps the complete snapshot", async () => {
  const points = densePoints(1234);
  const progress = [];
  const packed = await packHeatPointsAsync(points, {
    chunkSize: 200,
    yieldMode: "task",
    onProgress: (processed, total) => progress.push([processed, total])
  });
  assert.deepEqual(packed, packHeatPoints(points));
  assert.ok(progress.length >= 6);
  assert.deepEqual(progress.at(-1), [points.length, points.length]);

  const layer = heatLayer();
  await layer.setDataAsync(points, { chunkSize: 250, yieldMode: "task" });
  assert.equal(layer.count, points.length);
});

test("both mode reuses one field for colors and WASM contours", async () => {
  const points = densePoints(800);
  const options = {
    backend: "wasm",
    cols: 96,
    rows: 72,
    radius: 30,
    blur: 14,
    scaleZoom: 8,
    zoom: 8,
    levels: 5
  };
  const both = await buildHeat(points, [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
    ...options,
    mode: "both"
  });
  assert.ok(both);
  assert.equal(both.profile.backend, "wasm");
  assert.equal(both.profile.mode, "both");
  assert.ok(both.field.peak > 0);
  assert.ok(both.rings.length > 0);

  const colors = await buildHeat(points, [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
    ...options,
    mode: "heatmap"
  });
  assert.ok(colors);
  assert.deepEqual(both.field.grid, colors.field.grid);
  assert.equal(colors.rings.length, 0);
});

test("one-million-point field still produces contour geometry", async () => {
  const result = await buildPackedHeat(regionalPacked(1_000_000), [{ lat: 38, lng: -7 }, { lat: 61.5, lng: 21.5 }], {
    mode: "both",
    backend: "wasm",
    cols: 512,
    rows: 512,
    radius: 20,
    blur: 18,
    scaleZoom: 6,
    zoom: 6,
    levels: 5
  });
  assert.ok(result);
  assert.ok(result.field.peak > 0);
  assert.ok(result.thresholds.length > 0);
  assert.ok(result.rings.length > 0, `expected contours for 1M points, got ${result.rings.length}`);
});

test("packed heat snapshot retains the complete offscreen source domain", () => {
  const packed = packHeatPoints([[10, 20, 1], [45, -70, 2], [-25, 130, 3]]);
  assert.ok(packed.bounds);
  const bounds = packedHeatLatLngBounds(packed, 0.001);
  assert.ok(bounds);
  const request = createHeatFieldRequest(packed, bounds, { cols: 64, rows: 64, scaleZoom: 4 });
  assert.ok(request);
  for (let i = 0; i < packed.data.length; i += 3) {
    assert.ok(packed.data[i] >= request.westMerc && packed.data[i] <= request.westMerc + request.widthMerc);
    assert.ok(packed.data[i + 1] >= request.northMerc && packed.data[i + 1] <= request.northMerc + request.heightMerc);
  }
});

test("manual isoline step produces stable absolute levels", async () => {
  const result = await buildHeat(densePoints(1200), [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
    mode: "both",
    backend: "wasm",
    cols: 128,
    rows: 96,
    scaleZoom: 8,
    step: 25
  });
  assert.ok(result);
  assert.equal(result.profile.isolineStep, 25);
  assert.ok(result.thresholds.length > 1);
  assert.ok(result.thresholds.every((value, index) => value === (index + 1) * 25));
});

test("WebGPU request falls back deterministically when the runtime has no GPU", async () => {
  assert.equal(heatFieldWebGpuAvailable(), false);
  const packed = packHeatPoints(densePoints(50));
  const result = await buildPackedHeat(packed, [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
    mode: "heatmap",
    backend: "webgpu",
    cols: 48,
    rows: 36,
    scaleZoom: 8,
    zoom: 8
  });
  assert.ok(result);
  assert.equal(result.profile.requestedBackend, "webgpu");
  assert.equal(result.profile.backend, "wasm");
  assert.match(result.profile.fallbackReason, /WebGPU/i);
});

test("unified layer and ObjectManager expose the requested heat flags", () => {
  const layer = heatLayer(densePoints(20), {
    mode: "both",
    backend: "wasm",
    evaluation: "zoom",
    step: 0.25,
    labels: true
  });
  assert.equal(layer.count, 20);
  layer.setMode("isolines").setBackend("auto").setLabels(false);
  assert.equal(layer.options.mode, "isolines");
  assert.equal(layer.options.backend, "auto");
  assert.equal(layer.options.evaluation, "zoom");
  assert.equal(layer.options.step, 0.25);
  assert.equal(layer.options.domainOpacity, 0.08);
  assert.equal(layer.options.labels, false);
  assert.equal(layer.options.worker, true);
  assert.equal(layer.wantsFrameRender(), false);

  const manager = objectManager({
    visualization: "heatmap",
    heatmapDisplay: "both",
    heatmapBackend: "auto",
    heatmapEvaluation: "static",
    heatmapIsolineStep: 0.5,
    heatmapIsolineLabels: true
  });
  assert.equal(manager.options.heatmapDisplay, "both");
  assert.equal(manager.options.heatmapBackend, "auto");
  assert.equal(manager.options.heatmapEvaluation, "static");
  assert.equal(manager.options.heatmapIsolineStep, 0.5);
  assert.equal(manager.options.heatmapIsolineLabels, true);
  assert.throws(() => heatLayer([], { mode: "invalid" }), /heat mode/i);
  assert.throws(() => objectManager({ heatmapBackend: "cpu" }), /backend/i);
  assert.throws(() => objectManager({ heatmapEvaluation: "move" }), /evaluation/i);
  assert.throws(() => heatLayer([], { step: 0 }), /isoline step/i);
});

test("heat layer exposes selectable line and zone interaction state", () => {
  const layer = heatLayer([], { interactive: true, selectOnClick: true });
  const zone = {
    kind: "zone",
    fieldValue: 12,
    value: 12,
    t: 0.4,
    lowerValue: 10,
    upperValue: 15,
    levelId: 2
  };
  const events = [];
  layer.on("select", (event) => events.push([event.type, event.feature.kind]));
  layer.on("unselect", (event) => events.push([event.type, event.feature.kind]));
  layer.selectFeature(zone);
  assert.deepEqual(layer.getSelectedFeature(), zone);
  layer.clearSelection();
  assert.equal(layer.getSelectedFeature(), null);
  assert.deepEqual(events, [["select", "zone"], ["unselect", "zone"]]);
  layer.setInteractive(false);
  assert.equal(layer.options.interactive, false);
});
