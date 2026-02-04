import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind heat pipeline browser server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async () => {
    const { buildHeat, heatSupport } = await import("/dist/index.js");
    const support = await heatSupport();
    const points = Array.from({ length: 1500 }, (_, index) => {
      const angle = index * 0.13;
      const radius = 0.02 + (index % 50) * 0.001;
      return [50.08 + Math.sin(angle) * radius, 14.42 + Math.cos(angle) * radius, 0.5 + (index % 9) / 9];
    });
    const wasm = await buildHeat(points, [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
      mode: "both",
      backend: "wasm",
      cols: 128,
      rows: 96,
      scaleZoom: 8,
      zoom: 8,
      levels: 5
    });
    let webgpu = null;
    if (support.webgpu) {
      webgpu = await buildHeat(points, [{ lat: 49.8, lng: 13.9 }, { lat: 50.4, lng: 14.9 }], {
        mode: "heatmap",
        backend: "webgpu",
        cols: 128,
        rows: 96,
        scaleZoom: 8,
        zoom: 8
      });
    }
    return {
      wasm: wasm && {
        backend: wasm.profile.backend,
        peak: wasm.field.peak,
        rings: wasm.rings.length,
        cells: wasm.field.grid.length
      },
      webgpuAvailable: support.webgpu,
      webgpuSupported: support.webgpu,
      webgpu: webgpu && {
        backend: webgpu.profile.backend,
        peak: webgpu.field.peak,
        readbackMs: webgpu.profile.readbackMs,
        fallbackReason: webgpu.profile.fallbackReason,
        detail: webgpu.profile.webgpu
      }
    };
  });
  assert.equal(result.wasm.backend, "wasm");
  assert.ok(result.wasm.peak > 0);
  assert.ok(result.wasm.rings > 0);
  assert.equal(result.wasm.cells, 128 * 96);
  if (result.webgpuAvailable) {
    assert.ok(result.webgpu.peak > 0);
    if (result.webgpu.backend === "webgpu") {
      assert.ok(result.webgpu.readbackMs >= 0);
    } else {
      assert.equal(result.webgpu.backend, "wasm");
      assert.match(result.webgpu.fallbackReason, /WebGPU/i);
    }
  }
  const bundled = await page.evaluate(async () => {
    const { buildHeat, heatSupport } = await import("/dist/orihon.esm.js");
    const support = await heatSupport();
    const result = await buildHeat(
      [[50.08, 14.42, 1], [50.09, 14.43, 0.8]],
      [({ lat: 49.8, lng: 13.9 }), ({ lat: 50.4, lng: 14.9 })],
      { mode: "both", backend: "wasm", cols: 48, rows: 36, scaleZoom: 8, zoom: 8 }
    );
    return {
      supported: support.wasm,
      error: "",
      backend: result?.profile.backend,
      peak: result?.field.peak,
      rings: result?.rings.length
    };
  });
  assert.equal(bundled.supported, true, bundled.error);
  assert.equal(bundled.backend, "wasm");
  assert.ok(bundled.peak > 0);
  const layerWorker = await page.evaluate(async () => {
    const { createMap, heatLayer } = await import("/dist/orihon.esm.js");
    const host = document.createElement("div");
    host.style.width = "480px";
    host.style.height = "320px";
    document.body.appendChild(host);
    const map = createMap(host, { center: ({ lat: 50.08, lng: 14.42 }), zoom: 8, controls: false });
    const points = Array.from({ length: 4000 }, (_, index) => [
      50.08 + Math.sin(index * 0.17) * 0.08,
      14.42 + Math.cos(index * 0.17) * 0.12,
      0.5 + (index % 7) / 7
    ]);
    const layer = heatLayer(points, {
      mode: "both",
      backend: "wasm",
      worker: true,
      scaleZoom: 8
    }).addTo(map);
    await layer.rebuildAsync();
    map.setView(({ lat: 50.1, lng: 14.5 }), 8.5);
    await layer.rebuildAsync();
    const stats = layer.getStats();
    const frameDriven = layer.wantsFrameRender();
    layer.remove();
    map.remove();
    host.remove();
    return { worker: stats.worker, backend: stats.backend, rings: stats.rings, frameDriven };
  });
  assert.equal(layerWorker.worker, true);
  assert.equal(layerWorker.backend, "wasm");
  assert.ok(layerWorker.rings > 0);
  assert.equal(Boolean(layerWorker.frameDriven), false);
  console.log(`heat browser ok · wasm+contours · webgpu ${result.webgpuSupported ? "adapter" : "fallback-ready"}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
