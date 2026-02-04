import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createMap } from "../dist/map.js";
import { webglStyledPathBatch } from "../dist/layers/webgl-styled-path-batch.js";
import { webglPolygonBatch } from "../dist/layers/webgl-polygon-batch.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><div id='map'></div>", { pretendToBeVisual: true, url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  // Stub 2d context so canvas layers can paint.
  const proto = dom.window.HTMLCanvasElement.prototype;
  proto.getContext = function getContext(type) {
    if (type !== "2d") return null;
    if (!this.__ctx) {
      this.__ctx = {
        setTransform() {},
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        stroke() {},
        fill() {},
        setLineDash() {},
        paints: 0
      };
      const clearRect = this.__ctx.clearRect.bind(this.__ctx);
      this.__ctx.clearRect = (...args) => {
        this.__ctx.paints++;
        clearRect(...args);
      };
    }
    return this.__ctx;
  };

  const el = document.getElementById("map");
  Object.defineProperty(el, "clientWidth", { get: () => 800 });
  Object.defineProperty(el, "clientHeight", { get: () => 600 });
  el.getBoundingClientRect = () => ({
    width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {}; }
  });
  return el;
}

test("styled path batch pans with CSS translate instead of repainting", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 55.75, lng: 37.62 }, zoom: 10, controls: false });
  const batch = webglStyledPathBatch();
  batch.addTo(map);
  const positions = [];
  for (let i = 0; i < 5000; i++) positions.push({ lat: 55 + i * 0.0001, lng: 37 + Math.sin(i / 20) * 0.02 });
  batch.setPaths([{ id: 1, positions }]);
  const ctx = batch.canvas.getContext("2d");
  const paintsAfterSet = ctx.paints;
  assert.ok(paintsAfterSet >= 1);

  map.panBy([20, 0], { animate: false });
  batch.render();
  assert.equal(ctx.paints, paintsAfterSet, "pan must not clear/repaint canvas");
  assert.match(batch.canvas.style.transform || "", /translate\(/);

  const paintsBeforeZoom = ctx.paints;
  map.setZoom(11);
  // Map frame render already full-paints; an extra render at the new origin may CSS-translate(0,0).
  assert.ok(ctx.paints > paintsBeforeZoom, "zoom must full-repaint");
});

test("polygon batch pans with CSS translate instead of repainting", () => {
  const el = installDom();
  const map = createMap(el, { center: { lat: 55.75, lng: 37.62 }, zoom: 10, controls: false });
  const batch = webglPolygonBatch();
  batch.addTo(map);
  const ring = new Float64Array(2000);
  for (let i = 0; i < 1000; i++) {
    ring[i * 2] = 55.7 + (i / 1000) * 0.05;
    ring[i * 2 + 1] = 37.5 + Math.sin(i / 30) * 0.02;
  }
  batch.setPolygons([{ id: 1, rings: [ring] }]);
  const ctx = batch.canvas.getContext("2d");
  const paintsAfterSet = ctx.paints;

  map.panBy([12, -8], { animate: false });
  batch.render();
  assert.equal(ctx.paints, paintsAfterSet);
  assert.match(batch.canvas.style.transform || "", /translate\(/);
});
