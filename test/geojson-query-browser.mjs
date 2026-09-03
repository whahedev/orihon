import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { createOrihonTestServer } from "../scripts/browser-test-server.mjs";

const server = createOrihonTestServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind GeoJSON query browser server");

const data = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "parcel-7",
      properties: { name: "parcel" },
      geometry: {
        type: "Polygon",
        coordinates: [[[12.998, 51.998], [13.002, 51.998], [13.002, 52.002], [12.998, 52.002], [12.998, 51.998]]]
      }
    },
    {
      type: "Feature",
      id: "road-3",
      properties: { name: "road" },
      geometry: { type: "LineString", coordinates: [[12.99, 52.01], [13.01, 52.01]] }
    }
  ]
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);

  const probes = await page.evaluate(async (features) => {
    // The Advanced entry registers the WebGL batch factory; without it `renderer: "webgl"`
    // silently falls back to canvas and the GPU path would go untested.
    const api = await import("/dist/advanced-entry.js");
    document.body.innerHTML = "";
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:640px;height:480px";
    document.body.appendChild(host);
    const map = api.createMap(host, { center: { lat: 52, lng: 13 }, zoom: 14, controls: false });
    globalThis.geojsonQueryProbe = { map, api, features, clicks: [] };

    const polygonProbe = map.latLngToContainerPoint({ lat: 52, lng: 13 });
    const lineProbe = map.latLngToContainerPoint({ lat: 52.01, lng: 13 });
    const describe = (hit) => (hit
      ? { source: hit.source, id: hit.id ?? null, name: hit.feature?.properties?.name ?? null }
      : null);

    const result = { targets: { polygon: polygonProbe, line: lineProbe }, byRenderer: {} };
    for (const renderer of ["svg", "canvas", "webgl"]) {
      const layer = api.geoJSON(features, { renderer, interactive: true }).addTo(map);
      await new Promise((resolve) => setTimeout(resolve, 400));
      result.byRenderer[renderer] = {
        actualRenderer: layer.getLayers()[0]?.renderer ?? "svg",
        polygon: describe(map.query([polygonProbe.x, polygonProbe.y])[0]),
        line: describe(map.query([lineProbe.x, lineProbe.y])[0]),
        // Off every geometry, so nothing may answer.
        empty: map.query([6, 6]).length
      };
      layer.remove();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return result;
  }, data);

  for (const renderer of ["svg", "canvas", "webgl"]) {
    const probe = probes.byRenderer[renderer];
    const source = renderer === "svg" ? "svg" : renderer;
    if (renderer === "webgl") assert.equal(probe.actualRenderer, "webgl", "the browser really provides a WebGL context");
    assert.deepEqual(probe.polygon, { source, id: "parcel-7", name: "parcel" }, `${renderer} polygon hit`);
    assert.deepEqual(probe.line, { source, id: "road-3", name: "road" }, `${renderer} line hit`);
    assert.equal(probe.empty, 0, `${renderer} reports no hit off the geometry`);
  }

  // Each batch renderer is a single canvas, so it has to report clicks itself — one tap on the
  // polygon has to arrive as a click carrying that feature.
  for (const renderer of ["canvas", "webgl"]) {
    await page.evaluate(async (mode) => {
      const probe = globalThis.geojsonQueryProbe;
      probe.clicks = [];
      probe.layer = probe.api.geoJSON(probe.features, { renderer: mode, interactive: true }).addTo(probe.map);
      await new Promise((resolve) => setTimeout(resolve, 400));
      probe.layer.getLayers()[0].on("click", (event) => probe.clicks.push({ id: event.feature?.id ?? null, index: event.index }));
    }, renderer);
    await page.mouse.click(probes.targets.polygon.x, probes.targets.polygon.y);
    const clicks = await page.evaluate(() => globalThis.geojsonQueryProbe.clicks);
    assert.deepEqual(clicks, [{ id: "parcel-7", index: 0 }], `${renderer} batch emits a click carrying its feature`);
    await page.evaluate(() => globalThis.geojsonQueryProbe.layer.remove());
  }

  console.log("GeoJSON query browser test ok (svg, canvas, webgl)");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
