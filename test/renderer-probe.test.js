import test from "node:test";
import assert from "node:assert/strict";
import { GPUTileLayer, TileLayer, tileLayer } from "../dist/full-entry.js";

// The WebGL probe is module state, so this file must own the process: no other test may run a
// probe first. `GPUTileLayer` does not touch a canvas until it is added to a map, so a minimal
// document stub is enough to drive the probe both ways.
const URL_TEMPLATE = "https://tiles/{z}/{x}/{y}.png";
let context = null;
globalThis.document = {
  createElement: () => ({ getContext: () => context })
};

test("a failed WebGL probe is not remembered forever", () => {
  // The browser has no context to give right now — for example its live-context budget is
  // exhausted by other layers on the page.
  assert.throws(() => tileLayer(URL_TEMPLATE, { renderer: "webgl" }), (error) => {
    assert.equal(error.code, "ERR_UNSUPPORTED_CAPABILITY");
    assert.equal(error.context.reason, "unsupported");
    return true;
  });
  assert.ok(tileLayer(URL_TEMPLATE, { renderer: "auto" }) instanceof TileLayer, "auto still degrades");

  // Contexts free up. Caching the earlier failure would refuse for the rest of the page's life.
  let released = 0;
  context = { getExtension: () => ({ loseContext: () => { released += 1; } }) };
  assert.ok(tileLayer(URL_TEMPLATE, { renderer: "webgl" }) instanceof GPUTileLayer);
  assert.equal(released, 1, "the probe context is released immediately");

  // Success is memoized: a second request must not build another probe context.
  context = { getExtension: () => assert.fail("a successful probe must not be repeated") };
  assert.ok(tileLayer(URL_TEMPLATE, { renderer: "webgl" }) instanceof GPUTileLayer);
});
