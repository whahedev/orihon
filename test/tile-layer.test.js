import test from "node:test";
import assert from "node:assert/strict";
import { TileLayer } from "../dist/layers/tile-layer.js";

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
