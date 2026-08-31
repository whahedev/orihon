import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind GeoJSON browser test server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async () => {
    const { geoJSON } = await import("/dist/standard.js");
    const features = Array.from({ length: 11 }, (_, index) => ({
      type: "Feature",
      id: index,
      properties: { workerProbe: true },
      geometry: {
        type: "LineString",
        coordinates: [[13, 52 + index * 0.001], [13.1, 52.1 + index * 0.001]]
      }
    }));
    const blob = new Blob([JSON.stringify({ type: "FeatureCollection", features })]);
    const layer = geoJSON(null, { renderer: "webgl", interactive: false, retainFeatures: false });
    const progress = [];
    const originalParse = JSON.parse;
    JSON.parse = (text, ...args) => {
      if (typeof text === "string" && text.includes('"workerProbe"')) {
        throw new Error("raw GeoJSON was parsed on the main thread");
      }
      return originalParse(text, ...args);
    };
    try {
      await layer.addDataAsync(blob, {
        chunkSize: 4,
        useWorker: true,
        yieldMode: "task",
        onProgress: (processed, total) => progress.push([processed, total])
      });
    } finally {
      JSON.parse = originalParse;
    }
    return { count: layer.getLayers()[0]?.count, progress };
  });
  assert.equal(result.count, 11);
  assert.deepEqual(result.progress, [[4, 11], [8, 11], [11, 11]]);
  console.log("GeoJSON Worker ingestion browser test ok");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
