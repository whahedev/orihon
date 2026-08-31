import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind WebGL patch browser server");

const browser = await chromium.launch({ headless: true, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`http://127.0.0.1:${address.port}/`);

  const result = await page.evaluate(async () => {
    const api = await import("/dist/orihon.esm.js");
    const host = document.createElement("div");
    host.style.cssText = "width:800px;height:600px";
    document.body.appendChild(host);
    const map = api.createMap(host, { center: { lat: 50, lng: 10 }, zoom: 4, controls: false });

    const total = 40_000;
    const points = [];
    for (let i = 0; i < total; i += 1) {
      points.push({ lat: 35 + (i % 400) * 0.06, lng: -10 + Math.floor(i / 400) * 0.4 });
    }
    const layer = api.webglPointLayer(points, { pointSize: 2 }).addTo(map);
    await new Promise((resolve) => setTimeout(resolve, 500));

    let uploads = 0;
    const original = WebGLRenderingContext.prototype.bufferSubData;
    WebGLRenderingContext.prototype.bufferSubData = function patched(...args) {
      uploads += 1;
      return original.apply(this, args);
    };
    const count = (run) => { uploads = 0; run(); return uploads; };

    const batch = (indices, tick) => {
      const latLngs = new Float64Array(indices.length * 2);
      for (let i = 0; i < indices.length; i += 1) {
        latLngs[i * 2] = 40 + tick * 0.01 + i * 0.0001;
        latLngs[i * 2 + 1] = 5 + tick * 0.01;
      }
      return latLngs;
    };

    const big = Uint32Array.from({ length: 4000 }, (_, i) => i * 7 % total);
    const bigOneByOne = count(() => {
      const ll = batch(big, 1);
      for (let i = 0; i < big.length; i += 1) layer.patchPoint(big[i], ll[i * 2], ll[i * 2 + 1]);
    });
    const bigBatched = count(() => layer.patchPoints(big, batch(big, 2), big.length));

    // A handful of genuinely scattered points must stay partial rather than be promoted to a
    // full-buffer upload just because they cannot be merged.
    const few = Uint32Array.from({ length: 12 }, (_, i) => i * 2731 % total);
    const fewBatched = count(() => layer.patchPoints(few, batch(few, 3), few.length));

    // What moved must actually be where it was put.
    const probe = layer.points[big[0] * 2];
    WebGLRenderingContext.prototype.bufferSubData = original;
    return { total, bigOneByOne, bigBatched, fewBatched, probe };
  });

  assert.equal(result.bigOneByOne, 4000, "one call per point is one upload per point");
  assert.ok(result.bigBatched <= 4, `4000 points batched into ${result.bigBatched} uploads`);
  assert.ok(result.fewBatched <= 12, "a small scattered batch stays partial");
  assert.ok(result.fewBatched > 1, "and is not promoted to a full-buffer upload");
  assert.ok(Math.abs(result.probe - 40.02) < 0.5, `patched coordinates land in the buffer: ${result.probe}`);

  console.log(`webgl patch browser checks passed · 4000 points: ${result.bigOneByOne} uploads one by one, ${result.bigBatched} batched`);
} finally {
  await browser.close();
  server.close();
}
