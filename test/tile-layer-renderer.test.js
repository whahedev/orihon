import test from "node:test";
import assert from "node:assert/strict";
import { TileLayer, tileLayer as coreTileLayer, UnsupportedCapabilityError } from "../dist/core.js";
import { GPUTileLayer, tileLayer } from "../dist/index.js";

const URL_TEMPLATE = "https://tiles/{z}/{x}/{y}.png";

function withGpuNavigator(run) {
  const hadNav = globalThis.navigator != null;
  const nav = hadNav ? globalThis.navigator : {};
  if (!hadNav) globalThis.navigator = nav;
  const hadGpu = Object.prototype.hasOwnProperty.call(nav, "gpu");
  const prevGpu = nav.gpu;
  Object.defineProperty(nav, "gpu", { configurable: true, enumerable: true, writable: true, value: {} });
  try {
    run();
  } finally {
    if (hadGpu) Object.defineProperty(nav, "gpu", { configurable: true, enumerable: true, writable: true, value: prevGpu });
    else delete nav.gpu;
    if (!hadNav) delete globalThis.navigator;
  }
}

test("tileLayer default is DOM in every tier, GPU stays opt-in", () => {
  // The Advanced entry registers the GPU factory as an import side effect. That must widen
  // what `renderer` can select, never change what the default `tileLayer(url)` call builds.
  const advancedDefault = tileLayer(URL_TEMPLATE);
  const coreDefault = coreTileLayer(URL_TEMPLATE);
  assert.ok(advancedDefault instanceof TileLayer);
  assert.ok(coreDefault instanceof TileLayer);
  assert.equal(advancedDefault instanceof GPUTileLayer, false);
  assert.equal(advancedDefault.rendererKind, coreDefault.rendererKind);
});

test('renderer "auto" is a preference and degrades to DOM', () => {
  // Core registers no GPU implementation at all; node/jsdom also has no WebGL context.
  const coreAuto = coreTileLayer(URL_TEMPLATE, { renderer: "auto" });
  assert.ok(coreAuto instanceof TileLayer);
  assert.equal(coreAuto instanceof GPUTileLayer, false);

  const advancedAuto = tileLayer(URL_TEMPLATE, { renderer: "auto" });
  if (!(advancedAuto instanceof GPUTileLayer)) assert.ok(advancedAuto instanceof TileLayer);
});

test('renderer "webgl" / "webgpu" is a requirement and refuses rather than falling back', () => {
  // A named implementation is what the caller wants to profile. Handing back DOM tiles would
  // look like a GPU path in development and measure as a DOM path in production.
  // This file imports the Advanced entry, so the factory is registered process-wide and the
  // refusal comes from the missing browser support. The unregistered case lives in
  // dx-contracts.test.js, which imports orihon/core alone.
  for (const renderer of ["webgl", "webgpu"]) {
    for (const build of [coreTileLayer, tileLayer]) {
      assert.throws(() => build(URL_TEMPLATE, { renderer }), (error) => {
        assert.ok(error instanceof UnsupportedCapabilityError);
        assert.equal(error.code, "ERR_UNSUPPORTED_CAPABILITY");
        assert.equal(error.context.renderer, renderer);
        assert.equal(error.context.reason, "unsupported");
        return true;
      });
    }
  }
});

test("Advanced tileLayer uses WebGPU when navigator.gpu is present", () => {
  withGpuNavigator(() => {
    const autoLayer = tileLayer(URL_TEMPLATE, { renderer: "auto" });
    const defaultLayer = tileLayer(URL_TEMPLATE);
    const explicit = tileLayer(URL_TEMPLATE, { renderer: "webgpu", maxDpr: 1.25, maxNewPerFrame: 7 });
    const forcedDom = tileLayer(URL_TEMPLATE, { renderer: "dom" });

    assert.ok(autoLayer instanceof GPUTileLayer);
    assert.ok(defaultLayer instanceof TileLayer);
    assert.equal(defaultLayer instanceof GPUTileLayer, false);
    assert.ok(explicit instanceof GPUTileLayer);
    assert.equal(explicit.options.backend, "webgpu");
    assert.equal(explicit.options.maxDpr, 1.25);
    assert.equal(explicit.options.maxNewPerFrame, 7);
    assert.ok(forcedDom instanceof TileLayer);
    assert.equal(forcedDom instanceof GPUTileLayer, false);

    // navigator.gpu says nothing about WebGL, so that request still refuses.
    assert.throws(() => tileLayer(URL_TEMPLATE, { renderer: "webgl" }), { code: "ERR_UNSUPPORTED_CAPABILITY" });
  });
});
