import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind GPU tile browser server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async () => {
    const api = await import("/dist/orihon.esm.js");
    const host = document.createElement("div");
    host.style.cssText = "width:512px;height:320px";
    document.body.appendChild(host);
    const map = api.createMap(host, { center: ({ lat: 50.08, lng: 14.42 }), zoom: 5, controls: false });
    const loadContract = (layer) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No raster tileload event")), 5000);
      layer.once("tileload", (event) => {
        clearTimeout(timer);
        resolve({
          target: event.target === layer,
          coordinates: [event.x, event.y, event.z].every(Number.isFinite),
          url: typeof event.url === "string",
          detail: event.detail.url === event.url,
          hasTile: event.tile instanceof HTMLImageElement
        });
      });
    });
    const webgl = api.tileLayer("/assets/brand/png/orihon-mark-256.png", {
      renderer: "webgl",
      maxDpr: 1.25,
      maxNewPerFrame: 7,
      cacheSize: 48
    });
    const webglLoad = loadContract(webgl);
    webgl.addTo(map);
    const webglEvent = await webglLoad;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const webglStats = webgl.getStats?.() ?? null;
    const webglResult = {
      renderer: webglStats?.renderer ?? "dom",
      maxDpr: webgl.options.maxDpr,
      maxNewPerFrame: webgl.options.maxNewPerFrame,
      hasStats: typeof webgl.getStats === "function"
    };
    webgl.remove();

    const hasWebGpu = Boolean(navigator.gpu);
    // Explicit "webgpu" is a requirement: without navigator.gpu it must refuse rather than hand
    // back DOM tiles. "auto" is the preference form and still degrades.
    let webgpuRefusal = null;
    if (!hasWebGpu) {
      try {
        api.tileLayer("/assets/brand/png/orihon-mark-256.png", { renderer: "webgpu" });
        webgpuRefusal = { threw: false };
      } catch (error) {
        webgpuRefusal = { threw: true, code: error.code, name: error.name };
      }
    }
    const webgpu = api.tileLayer("/assets/brand/png/orihon-mark-256.png", {
      renderer: hasWebGpu ? "webgpu" : "auto",
      maxDpr: 1.5,
      maxNewPerFrame: 5
    });
    const webgpuLoad = loadContract(webgpu);
    webgpu.addTo(map);
    const webgpuEvent = await webgpuLoad;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const webgpuStats = webgpu.getStats?.() ?? null;
    const webgpuResult = {
      renderer: webgpuStats?.renderer ?? "dom",
      maxDpr: webgpu.options.maxDpr,
      maxNewPerFrame: webgpu.options.maxNewPerFrame,
      hasStats: typeof webgpu.getStats === "function"
    };
    webgpu.remove();
    map.setView({ lat: 0, lng: 0 }, 3);
    const points = api.webglPointLayer([], { interactive: true });
    points.setPackedData(new Float32Array([0, 0]), new Float64Array([0.5, 0.5])).addTo(map);
    let pointClick, pointLeave;
    points.once("click", (event) => { pointClick = event; });
    points.once("hover", (event) => { pointLeave = event; });
    const rect = host.getBoundingClientRect();
    points.canvas.dispatchEvent(new MouseEvent("click", { clientX: rect.left + 256, clientY: rect.top + 160, bubbles: true }));
    points.canvas.dispatchEvent(new MouseEvent("mouseleave"));
    const pointEvents = {
      target: pointClick?.target === points,
      index: pointClick?.index,
      noData: pointClick?.data === undefined,
      plainLatLng: Object.getPrototypeOf(pointClick?.latlng ?? {}) === Object.prototype,
      plainPoint: Object.getPrototypeOf(pointClick?.containerPoint ?? {}) === Object.prototype,
      nullHover: pointLeave?.latlng === null && pointLeave?.containerPoint === null && pointLeave?.data === null
    };
    map.destroy();
    host.remove();
    return { webgl: webglResult, webgpu: webgpuResult, hasWebGpu, webgpuRefusal, webglEvent, webgpuEvent, pointEvents };
  });

  assert.equal(result.webgl.renderer, "webgl");
  assert.equal(result.webgl.hasStats, true);
  assert.equal(result.webgl.maxDpr, 1.25);
  assert.equal(result.webgl.maxNewPerFrame, 7);
  assert.deepEqual(result.webglEvent, { target: true, coordinates: true, url: true, detail: true, hasTile: false });
  assert.deepEqual(result.webgpuEvent, { target: true, coordinates: true, url: true, detail: true, hasTile: result.webgpu.renderer === "dom" });
  assert.deepEqual(result.pointEvents, { target: true, index: 0, noData: true, plainLatLng: true, plainPoint: true, nullHover: true });
  if (result.hasWebGpu) {
    assert.equal(result.webgpu.hasStats, true);
    assert.ok(["webgpu", "webgl"].includes(result.webgpu.renderer));
    assert.equal(result.webgpu.maxDpr, 1.5);
    assert.equal(result.webgpu.maxNewPerFrame, 5);
  } else {
    assert.deepEqual(result.webgpuRefusal, {
      threw: true,
      code: "ERR_UNSUPPORTED_CAPABILITY",
      name: "UnsupportedCapabilityError"
    }, "explicit webgpu must refuse, not silently render DOM tiles");
  }
  console.log(`tile GPU browser ok · webgl active · webgpu ${result.hasWebGpu ? result.webgpu.renderer : "refused, auto → " + result.webgpu.renderer}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
