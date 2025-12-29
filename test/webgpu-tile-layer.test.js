import test from "node:test";
import assert from "node:assert/strict";
import { WebGPUTileLayer, webgpuTileLayer } from "orihon/webgpu";

test("webgpuTileLayer builds wrapped OSM-style URLs", () => {
  const layer = webgpuTileLayer("https://{s}.tile.example/{z}/{x}/{y}{r}.png", {
    subdomains: "abc"
  });
  assert.ok(layer instanceof WebGPUTileLayer);
  const url = layer.getTileUrl(3, 1, 2);
  assert.match(url, /^https:\/\/[abc]\.tile\.example\/2\/3\/1\.png$/);
  assert.equal(layer.getStats().renderer, "none");
  assert.equal(layer.getStats().cached, 0);
  assert.equal(layer.getStats().coveragePct, 100);
});

test("webgpuTileLayer supports TMS Y flip", () => {
  const layer = webgpuTileLayer("https://tiles/{z}/{x}/{y}.png", { tms: true });
  assert.equal(layer.getTileUrl(0, 1, 2), "https://tiles/2/0/2.png");
});

test("webgpuTileLayer setOpacity and setUrl", () => {
  const layer = webgpuTileLayer("https://a/{z}/{x}/{y}.png", { opacity: 0.4 });
  assert.equal(layer.options.opacity, 0.4);
  layer.setOpacity(0.25);
  assert.equal(layer.options.opacity, 0.25);
  layer.setOpacity(2);
  assert.equal(layer.options.opacity, 1);
  layer.setUrl("https://b/{z}/{x}/{y}.png", false);
  assert.equal(layer.getTileUrl(1, 2, 3), "https://b/3/1/2.png");
});
