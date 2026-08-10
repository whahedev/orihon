import test from "node:test";
import assert from "node:assert/strict";
import { Orihon } from "../dist/map.js";

class FakeClassList {
  values = new Set();
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
}

class FakeTarget {
  listeners = new Map();
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0);
  }
}

class FakeElement extends FakeTarget {
  constructor() {
    super();
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = new Map();
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.tabIndex = -1;
    this.parent = null;
  }
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  get firstChild() { return this.children[0] ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  closest() { return null; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

const fakeWindow = new FakeTarget();
fakeWindow.devicePixelRatio = 1;
globalThis.document = {
  createElement: () => new FakeElement(),
  getElementById: () => null
};
globalThis.window = fakeWindow;
globalThis.requestAnimationFrame = () => 1;
delete globalThis.ResizeObserver;

function runCycles(count) {
  for (let index = 0; index < count; index += 1) {
    const container = new FakeElement();
    const map = new Orihon(container, {
      center: [52.52, 13.405],
      zoom: index % 18,
      controls: false
    });
    map.panBy([index % 17, index % 11]);
    map.setZoom((index + 1) % 18);
    map.remove();
    map.remove();

    assert.equal(container.children.length, 0, `DOM nodes after cycle ${index}`);
    assert.equal(container.listenerCount(), 0, `container listeners after cycle ${index}`);
    assert.equal(map.layers.size, 0, `layers after cycle ${index}`);
  }
  assert.equal(fakeWindow.listenerCount(), 0, "window resize listeners");
}

test("100 create/remove cycles release DOM and listeners", () => {
  runCycles(100);
});

test("heap stays bounded across repeated lifecycle cycles", { skip: typeof globalThis.gc !== "function" }, () => {
  runCycles(25);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  runCycles(500);
  globalThis.gc();
  globalThis.gc();
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(growth < 4 * 1024 * 1024, `heap grew by ${(growth / 1024 / 1024).toFixed(2)} MiB`);
});
