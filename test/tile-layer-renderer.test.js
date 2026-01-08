import test from "node:test";
import assert from "node:assert/strict";
import { TileLayer, tileLayer as coreTileLayer } from "../dist/core.js";
import { GPUTileLayer, tileLayer } from "../dist/index.js";

test("Core tileLayer stays DOM even when renderer asks for webgl/auto", () => {
  const autoLayer = coreTileLayer("https://tiles/{z}/{x}/{y}.png");
  const webglAsk = coreTileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
  assert.ok(autoLayer instanceof TileLayer);
  assert.ok(webglAsk instanceof TileLayer);
  assert.equal(autoLayer instanceof GPUTileLayer, false);
});

test("Advanced tileLayer auto/webgl uses WebGL when factory is registered", () => {
  const autoLayer = tileLayer("https://tiles/{z}/{x}/{y}.png");
  const explicit = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
  const forcedDom = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "dom" });
  // jsdom / node may lack WebGL — then auto/webgl must fall back to DOM without throwing.
  if (autoLayer instanceof GPUTileLayer) {
    assert.ok(explicit instanceof GPUTileLayer);
  } else {
    assert.ok(autoLayer instanceof TileLayer);
    assert.ok(explicit instanceof TileLayer);
  }
  assert.ok(forcedDom instanceof TileLayer);
  assert.equal(forcedDom instanceof GPUTileLayer, false);
});

test("Advanced tileLayer uses WebGPU when navigator.gpu is present", () => {
  const hadNav = globalThis.navigator != null;
  const nav = hadNav ? globalThis.navigator : {};
  if (!hadNav) globalThis.navigator = nav;
  const hadGpu = Object.prototype.hasOwnProperty.call(nav, "gpu");
  const prevGpu = nav.gpu;
  Object.defineProperty(nav, "gpu", { configurable: true, enumerable: true, writable: true, value: {} });
  try {
    const autoLayer = tileLayer("https://tiles/{z}/{x}/{y}.png");
    const explicit = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgpu", maxDpr: 1.25, maxNewPerFrame: 7 });
    const webglAsk = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
    const forcedDom = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "dom" });
    assert.ok(autoLayer instanceof GPUTileLayer);
    assert.ok(explicit instanceof GPUTileLayer);
    assert.ok(webglAsk instanceof TileLayer);
    assert.equal(explicit.options.backend, "webgpu");
    assert.equal(explicit.options.maxDpr, 1.25);
    assert.equal(explicit.options.maxNewPerFrame, 7);
    assert.equal(webglAsk instanceof GPUTileLayer, false);
    assert.ok(forcedDom instanceof TileLayer);
    assert.equal(forcedDom instanceof GPUTileLayer, false);
  } finally {
    if (hadGpu) Object.defineProperty(nav, "gpu", { configurable: true, enumerable: true, writable: true, value: prevGpu });
    else delete nav.gpu;
    if (!hadNav) delete globalThis.navigator;
  }
});
