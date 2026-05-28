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
      interactive: true,
      scaleZoom: 8
    }).addTo(map);
    await layer.rebuildAsync();
    let rebuilt;
    layer.once("rebuild", (event) => { rebuilt = event; });
    map.setView(({ lat: 50.1, lng: 14.5 }), 8.5);
    await layer.rebuildAsync();
    const stats = layer.getStats();
    const frameDriven = layer.wantsFrameRender();
    let picked = null;
    for (let y = 16; y < 320 && !picked; y += 16) {
      for (let x = 16; x < 480; x += 16) {
        if (layer.getFeatureAt({ x, y })) { picked = { x, y }; break; }
      }
    }
    if (!picked) throw new Error("No heat feature available to test event payloads");
    let click, hover, selected;
    layer.once("click", (event) => { click = event; });
    layer.once("select", (event) => { selected = event; });
    layer.once("hover", (event) => { hover = event; });
    const rect = host.getBoundingClientRect();
    layer.canvas.dispatchEvent(new MouseEvent("click", { clientX: rect.left + picked.x, clientY: rect.top + picked.y, bubbles: true }));
    host.dispatchEvent(new MouseEvent("mouseleave"));
    const events = {
      clickTarget: click?.target === layer,
      feature: click?.feature === click?.data && typeof click?.feature?.fieldValue === "number",
      plainPoint: Object.getPrototypeOf(click?.containerPoint ?? {}) === Object.prototype,
      selection: selected?.feature === click?.feature,
      nullHover: hover?.latlng === null && hover?.feature === null && hover?.containerPoint === null,
      rebuild: rebuilt?.target === layer && typeof rebuilt?.stats?.rings === "number"
    };
    layer.remove();
    map.destroy();
    host.remove();
    return { worker: stats.worker, backend: stats.backend, rings: stats.rings, frameDriven, events };
  });
  assert.equal(layerWorker.worker, true);
  assert.equal(layerWorker.backend, "wasm");
  assert.ok(layerWorker.rings > 0);
  assert.equal(Boolean(layerWorker.frameDriven), false);
  assert.deepEqual(layerWorker.events, { clickTarget: true, feature: true, plainPoint: true, selection: true, nullHover: true, rebuild: true });

  // `levels` above 1 have always been absolute field values. Gradient stops now read the same
  // way, so a caller does not keep two conventions side by side in neighbouring options.
  const gradientScale = await page.evaluate(async () => {
    const { createMap, heatLayer } = await import("/dist/index.js");
    const REFERENCE = 40;
    const points = Array.from({ length: 900 }, (_, index) => {
      const angle = index * 0.21;
      const radius = 0.01 + (index % 30) * 0.0012;
      return [50.08 + Math.sin(angle) * radius, 14.42 + Math.cos(angle) * radius, 0.4 + (index % 7) / 10];
    });
    const paint = async (gradient) => {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:0;top:0;width:420px;height:320px";
      document.body.append(host);
      const map = createMap(host, { center: { lat: 50.08, lng: 14.42 }, zoom: 9, controls: false });
      const layer = heatLayer(points, {
        mode: "heatmap",
        backend: "wasm",
        evaluation: "static",
        worker: false,
        cols: 96,
        rows: 72,
        scaleZoom: 9,
        referenceMax: REFERENCE,
        gradient
      }).addTo(map);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const canvas = layer.canvas;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let signature = 0;
      let painted = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        painted += 1;
        signature = (signature * 31 + data[i] * 7 + data[i + 1] * 3 + data[i + 2]) >>> 0;
      }
      layer.remove();
      map.destroy();
      host.remove();
      return { painted, signature };
    };
    // The same ramp written both ways: fractions of referenceMax, and absolute field values.
    const fractional = await paint({ 0: "#22c55e", 0.25: "#eab308", 1: "#dc2626" });
    const absolute = await paint({ 0: "#22c55e", 10: "#eab308", 40: "#dc2626" });
    // A different absolute ramp must not collapse onto the same picture.
    const shifted = await paint({ 0: "#22c55e", 36: "#eab308", 40: "#dc2626" });
    return { fractional, absolute, shifted };
  });
  assert.ok(gradientScale.fractional.painted > 0, "the reference ramp paints something");
  assert.equal(
    gradientScale.absolute.signature,
    gradientScale.fractional.signature,
    "absolute gradient stops divided by referenceMax match the fractional ones"
  );
  assert.notEqual(
    gradientScale.shifted.signature,
    gradientScale.fractional.signature,
    "moving an absolute stop changes the picture, so the keys are not being clamped away"
  );

  console.log(`heat browser ok · wasm+contours · webgpu ${result.webgpuSupported ? "adapter" : "fallback-ready"}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
