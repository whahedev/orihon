import test from "node:test";
import assert from "node:assert/strict";
import { SvgLayer } from "../dist/layers/vector.js";

test("SvgLayer uses viewport-local coordinates at every zoom", () => {
  const attributes = new Map();
  const layer = new SvgLayer();
  layer.map = {
    size: { width: 800, height: 600 },
    pixelOrigin: { x: 1250.5, y: 840.25 }
  };
  layer.svg = {
    style: {},
    setAttribute(name, value) {
      attributes.set(name, value);
    }
  };

  layer.render();

  assert.equal(attributes.get("width"), "800");
  assert.equal(attributes.get("height"), "600");
  assert.equal(attributes.get("viewBox"), "0 0 800 600");
  assert.equal(layer.svg.style.left, "0px");
  assert.equal(layer.svg.style.top, "0px");
});
