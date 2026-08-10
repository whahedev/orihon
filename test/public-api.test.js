import test from "node:test";
import assert from "node:assert/strict";
import * as Orihon from "../dist/index.js";

test("public API exports stage one additions", () => {
  assert.equal(typeof Orihon.AttributionControl, "function");
  assert.equal(typeof Orihon.attributionControl, "function");
  assert.equal(typeof Orihon.metersToPixels, "function");
});

test("public API exports the complete geometry toolkit", () => {
  assert.equal(typeof Orihon.extendBounds, "function");
  assert.equal(typeof Orihon.scale, "function");
  assert.equal(typeof Orihon.zoomForBounds, "function");
  assert.equal(Orihon.TILE_SIZE, 256);
  assert.ok(Orihon.MAX_LAT > 85);
  assert.ok(Orihon.EARTH_RADIUS > 6_000_000);
});
