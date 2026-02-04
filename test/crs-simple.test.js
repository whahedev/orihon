import test from "node:test";
import assert from "node:assert/strict";
import { CRS, CRSCompatibilityError } from "../dist/crs.js";
import { Orihon } from "../dist/map.js";

class FakeClassList { add() {} remove() {} }
class FakeElement {
  constructor() { this.children = []; this.classList = new FakeClassList(); this.style = {}; this.attributes = new Map(); this.listeners = new Map(); this.clientWidth = 800; this.clientHeight = 600; }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  remove() {}
}

globalThis.document = { createElement: () => new FakeElement(), getElementById: () => null };
globalThis.window = new FakeElement();
globalThis.requestAnimationFrame = () => 1;

test("CRS.Simple projects map units without Mercator clamping", () => {
  const projected = CRS.Simple.project({ lat: 4000, lng: 1500 }, 2);
  assert.deepEqual(projected.toArray(), [6000, -16000]);
  assert.ok(CRS.Simple.unproject(projected, 2).equals({ lat: 4000, lng: 1500 }));
  assert.equal(CRS.Simple.scale(2), 4);
});

test("Simple maps use Euclidean units and viewport-local projection", () => {
  const map = new Orihon(new FakeElement(), { crs: "Simple", center: { lat: 200, lng: 300 }, zoom: 0, minZoom: -5, controls: false });
  assert.equal(map.crs, CRS.Simple);
  assert.deepEqual(map.latLngToContainerPoint({ lat: 200, lng: 300 }).toArray(), [400, 300]);
  assert.equal(map.distance({ lat: 0, lng: 0 }, { lat: 3, lng: 4 }), 5);
  map.fitWorld({ padding: 0 });
  assert.deepEqual(map.getCenter().toArray(), [128, 128]);
  map.remove();
});

test("CRS compatibility errors are typed", () => {
  const error = new CRSCompatibilityError();
  assert.equal(error.name, "CRSCompatibilityError");
  assert.equal(error.message, "WebGL layers require EPSG:3857");
});
