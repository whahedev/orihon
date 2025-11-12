import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"]
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/demo/wmts/capabilities.xml") {
    response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8" });
    response.end(`<?xml version="1.0"?><Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1"><Contents><Layer><ows:Identifier>lab-grid</ows:Identifier><Style><ows:Identifier>default</ows:Identifier></Style><TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet></TileMatrixSetLink><ResourceURL format="image/svg+xml" resourceType="tile" template="/demo/wmts/{TileMatrix}/{TileRow}/{TileCol}.svg"/></Layer></Contents></Capabilities>`);
    return;
  }
  const tile = /^\/demo\/wmts\/([^/]+)\/(\d+)\/(\d+)\.svg$/.exec(url.pathname);
  if (tile) {
    response.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#38bdf8" fill-opacity=".2"/><text x="8" y="20">${tile.slice(1).join("/")}</text></svg>`);
    return;
  }
  const file = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": mime.get(path.extname(file)) || "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Unable to bind P1 browser test server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/test/p1-browser-acceptance.html`);
  await page.waitForFunction(() => document.body.dataset.state !== "running");
  const state = await page.locator("body").getAttribute("data-state");
  const result = await page.locator("#result").innerText();
  assert.equal(state, "passed", result);
  const parsed = JSON.parse(result);
  assert.equal(parsed.topHit, "marker");
  assert.equal(parsed.spiderMarkers, 12);
  assert.equal(parsed.rtl, "rtl");
  assert.equal(parsed.visibleLabels, 1);
  assert.match(parsed.wmtsTile, /^\/demo\/wmts\//);
  console.log("P1 browser acceptance ok");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
