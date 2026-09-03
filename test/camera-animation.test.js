import test from "node:test";
import assert from "node:assert/strict";
import { Orihon } from "../dist/map.js";

class FakeClassList {
  values = new Set();
  toggle(name, force) { const on = force ?? !this.values.has(name); if (on) this.values.add(name); else this.values.delete(name); return on; }
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
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
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener() {}
  getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 }; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  remove() {}
  closest() { return null; }
  querySelectorAll() { return []; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

/**
 * Drives the camera by hand: `frame(t)` delivers exactly one rAF callback with
 * the timestamp the test chooses, so animation math is observable instead of
 * depending on wall-clock timing.
 */
function withManualFrames(run) {
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  const realCreate = globalThis.document;
  let pending = null;
  let id = 0;
  globalThis.requestAnimationFrame = (callback) => { pending = callback; return ++id; };
  globalThis.cancelAnimationFrame = () => { pending = null; };
  globalThis.document = { createElement: () => new FakeElement() };
  const frame = (timestamp) => {
    const callback = pending;
    pending = null;
    callback?.(timestamp);
    return Boolean(callback);
  };
  try {
    return run(frame, () => pending !== null);
  } finally {
    globalThis.requestAnimationFrame = realRaf;
    globalThis.cancelAnimationFrame = realCancel;
    globalThis.document = realCreate;
  }
}

function makeMap() {
  return new Orihon(new FakeElement(), { center: { lat: 0, lng: 0 }, zoom: 3, controls: false });
}

test("flyTo with a non-zero duration lands on the requested view", () => {
  withManualFrames((frame, hasPending) => {
    const map = makeMap();
    const start = performance.now();
    map.flyTo({ lat: 40, lng: 30 }, 8, { durationMs: 400 });
    assert.equal(map.isAnimating, true);

    let guard = 0;
    while (hasPending() && guard++ < 50) frame(start + guard * 100);

    assert.equal(map.isAnimating, false, "animation must settle");
    assert.equal(map.getZoom(), 8);
    assert.ok(Math.abs(map.getCenter().lat - 40) < 1e-6, `lat ${map.getCenter().lat}`);
    assert.ok(Math.abs(map.getCenter().lng - 30) < 1e-6, `lng ${map.getCenter().lng}`);
    map.destroy();
  });
});

test("flyTo emits zoomstart before zoomend and never overshoots the target zoom", () => {
  withManualFrames((frame, hasPending) => {
    const map = makeMap();
    const events = [];
    const zooms = [];
    map.on("zoomstart", () => events.push("zoomstart"));
    map.on("zoomend", () => events.push("zoomend"));
    map.on("zoom", () => zooms.push(map.getZoom()));

    const start = performance.now();
    map.flyTo({ lat: 10, lng: 10 }, 7, { durationMs: 300 });
    let guard = 0;
    while (hasPending() && guard++ < 50) frame(start + guard * 60);

    assert.deepEqual(events, ["zoomstart", "zoomend"]);
    assert.ok(zooms.length > 1, "expected intermediate zoom frames");
    for (const zoom of zooms) {
      assert.ok(zoom >= 3 && zoom <= 7, `intermediate zoom ${zoom} left the 3..7 range`);
    }
    map.destroy();
  });
});

test("a frame timestamp older than the animation start does not rewind the camera", () => {
  withManualFrames((frame, hasPending) => {
    const map = makeMap();
    const start = performance.now();
    map.flyTo({ lat: 20, lng: 20 }, 9, { durationMs: 400 });

    // rAF reports the time the frame started rendering, which can predate the
    // `performance.now()` captured when flyTo was called from inside that frame.
    frame(start - 50);
    assert.ok(map.getZoom() >= 3, `zoom rewound to ${map.getZoom()}`);

    let guard = 0;
    while (hasPending() && guard++ < 50) frame(start + guard * 100);
    assert.equal(map.getZoom(), 9);
    map.destroy();
  });
});

test("a no-op setView does not cancel a running flyTo", () => {
  withManualFrames((frame, hasPending) => {
    const map = makeMap();
    const start = performance.now();
    map.flyTo({ lat: 30, lng: 30 }, 6, { durationMs: 400 });
    frame(start + 100);
    assert.equal(map.isAnimating, true);

    // React effects re-run on every parent render and re-assert the current view.
    map.setView(map.getCenter(), map.getZoom());
    assert.equal(map.isAnimating, true, "no-op setView must not stop the camera");

    let guard = 0;
    while (hasPending() && guard++ < 50) frame(start + 100 + guard * 100);
    assert.equal(map.getZoom(), 6);
    map.destroy();
  });
});

test("a real setView still interrupts a running flyTo", () => {
  withManualFrames((frame, hasPending) => {
    const map = makeMap();
    const start = performance.now();
    map.flyTo({ lat: 30, lng: 30 }, 6, { durationMs: 400 });
    frame(start + 100);

    map.setView({ lat: -10, lng: -10 }, 4);
    assert.equal(map.isAnimating, false);
    assert.equal(map.getZoom(), 4);
    assert.equal(hasPending(), false);
    map.destroy();
  });
});

test("a settled animation leaves no pan velocity behind", () => {
  withManualFrames((frame, hasPending) => {
    const map = makeMap();
    const start = performance.now();
    map.flyTo({ lat: 5, lng: 5 }, 3, { durationMs: 200 });
    let guard = 0;
    while (hasPending() && guard++ < 50) frame(start + guard * 60);
    assert.equal(map.isAnimating, false);
    assert.equal(map.panVelocity.x, 0);
    assert.equal(map.panVelocity.y, 0);
    map.destroy();
  });
});
