import test from "node:test";
import assert from "node:assert/strict";
import { WebGLTileLayer, webglTileLayer } from "../dist/index.js";

test("webglTileLayer builds wrapped OSM-style URLs", () => {
  const layer = webglTileLayer("https://{s}.tile.example/{z}/{x}/{y}{r}.png", {
    subdomains: "abc"
  });
  assert.ok(layer instanceof WebGLTileLayer);
  const url = layer.getTileUrl(3, 1, 2);
  assert.match(url, /^https:\/\/[abc]\.tile\.example\/2\/3\/1\.png$/);
  assert.equal(layer.getStats().renderer, "none");
  assert.equal(layer.getStats().cached, 0);
});

test("webglTileLayer supports TMS Y flip", () => {
  const layer = webglTileLayer("https://tiles/{z}/{x}/{y}.png", { tms: true });
  // z=2 → worldSize 4; y=1 → tms y = 4-1-1 = 2
  assert.equal(layer.getTileUrl(0, 1, 2), "https://tiles/2/0/2.png");
});

test("webglTileLayer rejects invalid bounds", () => {
  assert.throws(
    () => webglTileLayer("https://tiles/{z}/{x}/{y}.png", { bounds: { north: 1 } }),
    /bounds/
  );
});
