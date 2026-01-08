import test from "node:test";
import assert from "node:assert/strict";
import { GPUTileLayer } from "orihon/webgpu";

test("GPUTileLayer webgpu backend builds wrapped OSM-style URLs", () => {
  const layer = new GPUTileLayer("https://{s}.tile.example/{z}/{x}/{y}{r}.png", {
    backend: "webgpu",
    subdomains: "abc"
  });
  assert.ok(layer instanceof GPUTileLayer);
  const url = layer.getTileUrl(3, 1, 2);
  assert.match(url, /^https:\/\/[abc]\.tile\.example\/2\/3\/1\.png$/);
  assert.equal(layer.getStats().renderer, "none");
  assert.equal(layer.getStats().cached, 0);
  assert.equal(layer.getStats().coveragePct, 100);
});

test("GPUTileLayer supports TMS Y flip", () => {
  const layer = new GPUTileLayer("https://tiles/{z}/{x}/{y}.png", { backend: "webgpu", tms: true });
  assert.equal(layer.getTileUrl(0, 1, 2), "https://tiles/2/0/2.png");
});

test("GPUTileLayer setOpacity and setUrl", () => {
  const layer = new GPUTileLayer("https://a/{z}/{x}/{y}.png", { backend: "webgpu", opacity: 0.4 });
  assert.equal(layer.options.opacity, 0.4);
  layer.setOpacity(0.25);
  assert.equal(layer.options.opacity, 0.25);
  layer.setOpacity(2);
  assert.equal(layer.options.opacity, 1);
  layer.setUrl("https://b/{z}/{x}/{y}.png", false);
  assert.equal(layer.getTileUrl(1, 2, 3), "https://b/3/1/2.png");
});

