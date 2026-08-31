import test from "node:test";
import assert from "node:assert/strict";
import { GPUTileLayer } from "../dist/full-entry.js";

test("GPUTileLayer webgl backend builds wrapped OSM-style URLs", () => {
  const layer = new GPUTileLayer("https://{s}.tile.example/{z}/{x}/{y}{r}.png", {
    backend: "webgl",
    subdomains: "abc"
  });
  assert.ok(layer instanceof GPUTileLayer);
  const url = layer.getTileUrl(3, 1, 2);
  assert.match(url, /^https:\/\/[abc]\.tile\.example\/2\/3\/1\.png$/);
  assert.equal(layer.getStats().renderer, "none");
  assert.equal(layer.getStats().cached, 0);
  assert.equal(layer.getStats().visibleReady, 0);
  assert.equal(layer.getStats().preloadNeeded, 0);
  assert.equal(layer.getStats().coveragePct, 100);
});

test("GPUTileLayer supports TMS Y flip", () => {
  const layer = new GPUTileLayer("https://tiles/{z}/{x}/{y}.png", { backend: "webgl", tms: true });
  // z=2 → worldSize 4; y=1 → tms y = 4-1-1 = 2
  assert.equal(layer.getTileUrl(0, 1, 2), "https://tiles/2/0/2.png");
});

test("GPUTileLayer setOpacity updates options and canvas style", () => {
  const layer = new GPUTileLayer("https://tiles/{z}/{x}/{y}.png", { backend: "webgl", opacity: 0.4 });
  assert.equal(layer.options.opacity, 0.4);
  layer.setOpacity(0.25);
  assert.equal(layer.options.opacity, 0.25);
  layer.setOpacity(2);
  assert.equal(layer.options.opacity, 1);
  layer.setOpacity(Number.NaN);
  assert.equal(layer.options.opacity, 1);
});

test("GPUTileLayer setUrl replaces template", () => {
  const layer = new GPUTileLayer("https://a/{z}/{x}/{y}.png", { backend: "webgl" });
  layer.setUrl("https://b/{z}/{x}/{y}.png", false);
  assert.equal(layer.getTileUrl(1, 2, 3), "https://b/3/1/2.png");
});

