import test from "node:test";
import assert from "node:assert/strict";
import { Orihon } from "../dist/map.js";

class FakeClassList {
  values = new Set();
  toggle(name, force) { const on = force ?? !this.values.has(name); if (on) this.values.add(name); else this.values.delete(name); return on; }
  add(...names) {
    for (const name of names) this.values.add(name);
  }
  remove(...names) {
    for (const name of names) this.values.delete(name);
  }
}

class FakeElement {
  constructor() {
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.clientWidth = 800;
    this.clientHeight = 600;
  }
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((candidate) => candidate !== handler));
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    return !event.defaultPrevented;
  }
  closest() { return null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function pointerEvent(type, values) {
  return {
    type,
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerType: "mouse",
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...values
  };
}

globalThis.document = {
  createElement: () => new FakeElement(),
  getElementById: () => null
};
globalThis.window = new FakeElement();
globalThis.requestAnimationFrame = () => 1;

test("setZoomAround keeps its anchor stable before a render frame", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 52.52, lng: 13.405 }, zoom: 8, controls: false });
  const anchor = { x: 125, y: 90 };
  const original = map.containerPointToLatLng(anchor);

  map.setZoomAround(anchor, 9);
  map.setZoomAround(anchor, 10);
  const actual = map.containerPointToLatLng(anchor);

  assert.ok(Math.abs(actual.lat - original.lat) < 1e-9);
  assert.ok(Math.abs(actual.lng - original.lng) < 1e-9);
  map.destroy();
});

test("programmatic zoom emits one complete view lifecycle", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 2, controls: false });
  const events = [];
  for (const type of ["movestart", "zoomstart", "zoom", "move", "zoomend", "moveend"]) {
    map.on(type, () => events.push(type));
  }

  map.setZoomAround({ x: 100, y: 100 }, 3);
  assert.deepEqual(events, ["movestart", "zoomstart", "zoom", "move", "zoomend", "moveend"]);

  events.length = 0;
  map.setView(map.center, map.zoom);
  assert.deepEqual(events, []);
  map.destroy();
});

test("updateView keeps the gesture open until setView finishes it", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 2, controls: false });
  const events = [];
  for (const type of ["movestart", "move", "moveend"]) {
    map.on(type, () => events.push(type));
  }

  map.updateView({ lat: 1, lng: 1 }, 2);
  assert.deepEqual(events, ["movestart", "move"], "the first step opens the gesture");

  events.length = 0;
  map.updateView({ lat: 2, lng: 2 }, 2);
  assert.deepEqual(events, ["move"], "further steps stay inside the open gesture");

  events.length = 0;
  map.setView(map.getCenter(), map.getZoom());
  assert.deepEqual(events, ["moveend"], "setView finishes it even when the view did not change");
  map.destroy();
});

test("zoom limits can be narrowed at runtime and re-clamp the live zoom", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 4, controls: false });

  // Raising the floor above the live zoom must move the camera, not leave the map outside
  // its own limits until the next interaction.
  map.setMinZoom(6);
  assert.equal(map.options.minZoom, 6);
  assert.equal(map.getZoom(), 6);

  map.setMaxZoom(8);
  assert.equal(map.options.maxZoom, 8);
  map.setZoom(12);
  assert.equal(map.getZoom(), 8);

  assert.throws(() => map.setMinZoom(Number.NaN), TypeError);
  assert.throws(() => map.setMaxZoom("9"), TypeError);
  assert.throws(() => map.setMinZoom(9), RangeError);
  assert.throws(() => map.setMaxZoom(5), RangeError);
  assert.equal(map.options.minZoom, 6);
  assert.equal(map.options.maxZoom, 8);
  map.destroy();
});

test("camera moves name their animation and reject the removed animate flag", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 4, controls: false });
  const berlin = [{ lat: 52.4, lng: 13.2 }, { lat: 52.6, lng: 13.6 }];

  // Default jumps: the move is terminal, so nothing is animating afterwards.
  map.fitBounds(berlin);
  assert.equal(map.isAnimating, false);
  const jumped = map.getCenter();

  map.setView({ lat: 0, lng: 0 }, 4);
  map.fitBounds(berlin, { animation: "fly" });
  assert.equal(map.isAnimating, true, '"fly" runs the flyTo curve instead of jumping');
  map.stop();

  // An unknown key in an options bag is silently ignored by JavaScript, so the rename has to
  // fail loudly rather than quietly stop animating.
  for (const call of [
    () => map.fitBounds(berlin, { animate: true }),
    () => map.fitWorld({ animate: true }),
    () => map.panInsideBounds(berlin, { animate: true })
  ]) {
    assert.throws(call, (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /animate was removed/);
      return true;
    });
  }
  assert.throws(() => map.fitBounds(berlin, { animation: "ease" }), /Unknown camera animation/);
  assert.throws(() => map.fitBounds(berlin, { animation: "fly", durationMs: -1 }), RangeError);

  void jumped;
  map.destroy();
});

test("LatLng is immutable at runtime, not only in the type surface", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 10, lng: 20 }, zoom: 2, controls: false });
  const centre = map.getCenter();
  assert.equal(Object.isFrozen(centre), true);
  assert.throws(() => { centre.lat = 0; }, TypeError);
  assert.throws(() => { map.getCamera().center.lat = 0; }, TypeError);
  assert.equal(map.getCenter().lat, 10);
  map.destroy();
});

test("layer coordinates remain viewport-local after panBy", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 52.52, lng: 13.405 }, zoom: 10, controls: false });
  const before = map.latLngToLayerPoint(map.getCenter());
  map.panBy([120, -45]);
  const after = map.latLngToLayerPoint(map.getCenter());
  assert.ok(Math.abs(after.x - before.x) < 1e-7);
  assert.ok(Math.abs(after.y - before.y) < 1e-7);
  map.destroy();
});

test("layer coordinates stay small and precise at maximum zoom", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 52.52, lng: 13.405 }, zoom: 19, controls: false });
  const center = map.latLngToLayerPoint(map.getCenter());
  const nearby = map.latLngToLayerPoint({ lat: 52.5201, lng: 13.4051 });

  assert.deepEqual(center.toArray(), [400, 300]);
  assert.ok(Math.abs(nearby.x) < 1000);
  assert.ok(Math.abs(nearby.y) < 1000);
  map.destroy();
});

test("navigation helpers and maxBounds are exposed", () => {
  const map = new Orihon(new FakeElement(), {
    center: { lat: 0, lng: 0 },
    zoom: 4,
    controls: false,
    maxBounds: [{ lat: -10, lng: -10 }, { lat: 10, lng: 10 }]
  });

  map.zoomIn();
  assert.equal(map.getZoom(), 5);
  map.zoomOut(2);
  assert.equal(map.getZoom(), 3);

  map.setView({ lat: 80, lng: 80 }, 8);
  assert.equal(map.getMaxBounds().contains(map.getCenter()), true);

  map.flyTo({ lat: 1, lng: 1 }, 6, { durationMs: 0 });
  assert.equal(map.getZoom(), 6);
  assert.ok(Math.abs(map.getCenter().lat - 1) < 1e-9);
  assert.ok(Math.abs(map.getCenter().lng - 1) < 1e-9);

  map.fitWorld({ padding: 0 });
  assert.ok(map.getZoom() <= 2);
  map.stop();
  map.destroy();
});

test("remove() is a terminal alias of destroy()", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 2, controls: false });
  assert.equal(map.remove(), map);
  assert.equal(map.isDestroyed, true);
  // Idempotent, like destroy(), and the two spellings stay interchangeable.
  assert.equal(map.remove(), map);
  assert.equal(map.destroy(), map);
});

test("destroy cancels in-flight flyTo animation", () => {
  let frames = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames++;
    if (frames < 3) setTimeout(() => callback(frames * 16), 0);
    return frames;
  };
  globalThis.cancelAnimationFrame = () => {};

  const map = new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 2, controls: false });
  map.flyTo({ lat: 10, lng: 10 }, 6, { durationMs: 1000 });
  assert.equal(map.isAnimating, true);
  map.destroy();
  assert.equal(map.isDestroyed, true);
  assert.equal(map.isAnimating, false);
  assert.equal(map.setView({ lat: 20, lng: 20 }, 8), map);
  assert.equal(map.getZoom(), 2);
});

test("box zoom centers the selected screen rectangle", () => {
  const map = new Orihon(new FakeElement(), { center: { lat: 52.52, lng: 13.405 }, zoom: 10, controls: false });
  const expectedCenter = map.containerPointToLatLng([200, 175]);

  map.container.dispatchEvent(pointerEvent("pointerdown", {
    pointerId: 10,
    clientX: 100,
    clientY: 100,
    shiftKey: true
  }));
  map.container.dispatchEvent(pointerEvent("pointermove", {
    pointerId: 10,
    clientX: 300,
    clientY: 250,
    shiftKey: true
  }));
  map.container.dispatchEvent(pointerEvent("pointerup", {
    pointerId: 10,
    clientX: 300,
    clientY: 250,
    shiftKey: true
  }));

  assert.ok(map.getZoom() > 10);
  assert.ok(Math.abs(map.getCenter().lat - expectedCenter.lat) < 1e-9);
  assert.ok(Math.abs(map.getCenter().lng - expectedCenter.lng) < 1e-9);
  map.destroy();
});

test("custom panes and ResizeObserver lifecycle are managed by the map", () => {
  let callback;
  let disconnected = false;
  globalThis.ResizeObserver = class {
    constructor(next) { callback = next; }
    observe() {}
    disconnect() { disconnected = true; }
  };

  const container = new FakeElement();
  const map = new Orihon(container, { controls: false });
  const pane = map.createPane("labels");
  assert.equal(map.getPane("labels"), pane);
  assert.equal(map.getPanes().labels, pane);
  assert.deepEqual(map.getSize().toArray(), [800, 600]);

  let resizeEvent;
  map.on("resize", (event) => { resizeEvent = event; });
  container.clientWidth = 640;
  container.clientHeight = 480;
  callback();
  assert.deepEqual(map.getSize().toArray(), [640, 480]);
  assert.deepEqual(resizeEvent.oldSize.toArray(), [800, 600]);
  assert.deepEqual(resizeEvent.newSize.toArray(), [640, 480]);
  assert.deepEqual(map.latLngToContainerPoint(map.getCenter()).toArray(), [320, 240]);

  map.removePane("labels");
  assert.equal(map.getPane("labels"), null);
  map.destroy();
  assert.equal(disconnected, true);
  delete globalThis.ResizeObserver;
});
