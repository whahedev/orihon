import test from "node:test";
import assert from "node:assert/strict";
import { CircleMarker, SvgLayer } from "../dist/layers/vector.js";
import { CRS } from "../dist/crs.js";
import { Point } from "../dist/geo.js";

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

function mockMap(center, zoom, size = { width: 800, height: 600 }) {
  const origin = CRS.EPSG3857.project(center, zoom);
  const pixelOrigin = new Point(origin.x - size.width / 2, origin.y - size.height / 2);
  return {
    size,
    zoom,
    crs: CRS.EPSG3857,
    pixelOrigin,
    latLngToLayerPoint(value) {
      return CRS.EPSG3857.project(value, zoom).subtract(pixelOrigin);
    }
  };
}

test("CircleMarker keeps a constant pixel radius when zooming in", () => {
  const center = [55.75, 37.62];
  const radius = 7;
  const layer = new CircleMarker(center, { radius });
  const attributes = new Map();
  layer.path = {
    setAttribute(name, value) {
      attributes.set(name, String(value));
    }
  };
  layer.svg = {
    style: {},
    setAttribute() {}
  };

  for (const zoom of [0, 4, 10, 14, 18, 19, 22]) {
    layer.map = mockMap(center, zoom);
    attributes.clear();
    layer.render();
    assert.equal(attributes.get("r"), String(radius), `radius at zoom ${zoom}`);
    assert.ok(Math.abs(Number(attributes.get("cx")) - 400) < 1e-6, `cx at zoom ${zoom}`);
    assert.ok(Math.abs(Number(attributes.get("cy")) - 300) < 1e-6, `cy at zoom ${zoom}`);
  }
});
