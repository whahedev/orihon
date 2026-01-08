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
    const map = api.createMap(host, { center: [50.08, 14.42], zoom: 5, controls: false });
    const webgl = api.tileLayer("/assets/brand/png/orihon-mark-256.png", {
      renderer: "webgl",
      maxDpr: 1.25,
      maxNewPerFrame: 7,
      cacheSize: 48
    }).addTo(map);
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
    const webgpu = api.tileLayer("/assets/brand/png/orihon-mark-256.png", {
      renderer: "webgpu",
      maxDpr: 1.5,
      maxNewPerFrame: 5
    }).addTo(map);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const webgpuStats = webgpu.getStats?.() ?? null;
    const webgpuResult = {
      renderer: webgpuStats?.renderer ?? "dom",
      maxDpr: webgpu.options.maxDpr,
      maxNewPerFrame: webgpu.options.maxNewPerFrame,
      hasStats: typeof webgpu.getStats === "function"
    };
    map.remove();
    host.remove();
    return { webgl: webglResult, webgpu: webgpuResult, hasWebGpu };
  });

  assert.equal(result.webgl.renderer, "webgl");
  assert.equal(result.webgl.hasStats, true);
  assert.equal(result.webgl.maxDpr, 1.25);
  assert.equal(result.webgl.maxNewPerFrame, 7);
  if (result.hasWebGpu) {
    assert.equal(result.webgpu.hasStats, true);
    assert.ok(["webgpu", "webgl"].includes(result.webgpu.renderer));
    assert.equal(result.webgpu.maxDpr, 1.5);
    assert.equal(result.webgpu.maxNewPerFrame, 5);
  } else {
    assert.equal(result.webgpu.hasStats, false);
    assert.equal(result.webgpu.renderer, "dom");
  }
  console.log(`tile GPU browser ok · webgl active · webgpu ${result.hasWebGpu ? result.webgpu.renderer : "DOM fallback"}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
