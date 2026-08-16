import test from "node:test";
import assert from "node:assert/strict";
import { TileLayer, tileLayer as coreTileLayer } from "../dist/core.js";
import { WebGLTileLayer, tileLayer, webglTileLayer } from "../dist/index.js";
import { WebGPUTileLayer } from "orihon/webgpu";

test("Core tileLayer stays DOM even when renderer asks for webgl/auto", () => {
  const autoLayer = coreTileLayer("https://tiles/{z}/{x}/{y}.png");
  const webglAsk = coreTileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
  assert.ok(autoLayer instanceof TileLayer);
  assert.ok(webglAsk instanceof TileLayer);
  assert.equal(autoLayer instanceof WebGLTileLayer, false);
});

test("Advanced tileLayer auto/webgl uses WebGL when factory is registered", () => {
  const autoLayer = tileLayer("https://tiles/{z}/{x}/{y}.png");
  const explicit = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
  const forcedDom = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "dom" });
  // jsdom / node may lack WebGL — then auto/webgl must fall back to DOM without throwing.
  if (autoLayer instanceof WebGLTileLayer) {
    assert.ok(explicit instanceof WebGLTileLayer);
  } else {
    assert.ok(autoLayer instanceof TileLayer);
    assert.ok(explicit instanceof TileLayer);
  }
  assert.ok(forcedDom instanceof TileLayer);
  assert.equal(forcedDom instanceof WebGLTileLayer, false);
});

test("webglTileLayer remains an explicit GPU constructor", () => {
  const layer = webglTileLayer("https://tiles/{z}/{x}/{y}.png");
  assert.ok(layer instanceof WebGLTileLayer);
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
    const explicit = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgpu" });
    const webglAsk = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "webgl" });
    const forcedDom = tileLayer("https://tiles/{z}/{x}/{y}.png", { renderer: "dom" });
    assert.ok(autoLayer instanceof WebGPUTileLayer);
    assert.ok(explicit instanceof WebGPUTileLayer);
    assert.equal(webglAsk instanceof WebGPUTileLayer, false);
    assert.ok(forcedDom instanceof TileLayer);
    assert.equal(forcedDom instanceof WebGPUTileLayer, false);
  } finally {
    if (hadGpu) Object.defineProperty(nav, "gpu", { configurable: true, enumerable: true, writable: true, value: prevGpu });
    else delete nav.gpu;
    if (!hadNav) delete globalThis.navigator;
  }
});
