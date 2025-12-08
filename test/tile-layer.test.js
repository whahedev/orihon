import test from "node:test";
import assert from "node:assert/strict";
import { TileLayer, nativeTileZoom } from "../dist/layers/tile-layer.js";

test("TileLayer wraps X and replaces every URL token", () => {
  const layer = new TileLayer("https://{s}.tiles/{z}/{x}/{y}/{x}{r}.png", {
    subdomains: ["a"]
  });
  assert.equal(layer.getTileUrl(-1, 2, 3), "https://a.tiles/3/7/2/7.png");
});

test("TileLayer supports TMS Y coordinates", () => {
  const layer = new TileLayer("https://tiles/{z}/{x}/{y}.png", { tms: true });
  assert.equal(layer.getTileUrl(2, 1, 3), "https://tiles/3/2/6.png");
});

test("TileLayer validates source bounds", () => {
  assert.throws(
    () => new TileLayer("https://tiles/{z}/{x}/{y}.png", { bounds: { north: 1 } }),
    /bounds/
  );
});

test("nativeTileZoom accepts numbers and numeric strings", () => {
  assert.equal(nativeTileZoom(12, 19), 12);
  assert.equal(nativeTileZoom("8", 19), 8);
  assert.equal(nativeTileZoom(undefined, 19), 19);
  assert.equal(nativeTileZoom("", 19), 19);
});
