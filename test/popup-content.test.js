import test from "node:test";
import assert from "node:assert/strict";
import { Popup, geoJSON, marker, createMap } from "../dist/index.js";

class FakeContentNode {
  constructor() {
    this.children = [];
    this.attributes = new Map();
    this.textContent = "";
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...children) {
    this.children = children;
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
}

class FakeClassList {
  values = new Set();
  add(...names) {
    for (const name of names) this.values.add(name);
  }
  remove(...names) {
    for (const name of names) this.values.delete(name);
  }
}

class FakeElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.clientWidth = 800;
    this.clientHeight = 600;
    this.className = "";
    this.textContent = "";
    this.parent = null;
    if (this.tagName === "CANVAS") {
      this.width = 0;
      this.height = 0;
      this.getContext = () => ({
        clearRect() {},
        fillRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fillText() {},
        fillStyle: "",
        strokeStyle: "",
        font: "",
        textAlign: ""
      });
    }
  }
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...children) {
    this.children = children;
    for (const child of children) child.parent = this;
    this.textContent = "";
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
  querySelector(selector) {
    const match = (node) => {
      if (selector.startsWith(".") && String(node.className || "").includes(selector.slice(1))) return node;
      if (selector === "canvas" && node.tagName === "CANVAS") return node;
      for (const child of node.children ?? []) {
        const found = match(child);
        if (found) return found;
      }
      return null;
    };
    return match(this);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

function installDom() {
  globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null
  };
  globalThis.window = new FakeElement("window");
  globalThis.requestAnimationFrame = (fn) => {
    fn(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Node = class FakeNode {};
}

test("mountable popup content receives context and is disposed on close", () => {
  let received;
  let cleanup = 0;
  let unmount = 0;
  const source = { id: "source" };
  const popup = new Popup((context) => ({
    mount(container, mountContext) {
      received = mountContext;
      container.appendChild({ kind: "chart" });
      return () => { cleanup += 1; };
    },
    unmount() { unmount += 1; }
  }), { autoPan: false, closeButton: false });
  popup.contentNode = new FakeContentNode();
  popup.setLatLng([52.52, 13.405]);
  popup.setContentContext({ source, data: { value: 42 } });

  assert.equal(received.source, source);
  assert.deepEqual(received.data, { value: 42 });
  assert.deepEqual(received.latlng.toArray(), [52.52, 13.405]);
  assert.equal(popup.contentNode.children[0].kind, "chart");

  popup.onRemove();
  assert.equal(cleanup, 1);
  assert.equal(unmount, 1);
});

test("async popup factories resolve safely", async () => {
  const popup = new Popup(async () => "Loaded", { autoPan: false, closeButton: false });
  const node = new FakeContentNode();
  popup.contentNode = node;
  popup.setContentContext({ data: 1 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(node.textContent, "Loaded");
  popup.onRemove();
});

test("GeoJSON popup factory binds to every feature layer", () => {
  const layer = geoJSON({
    type: "FeatureCollection",
    features: [
      { type: "Feature", id: "a", properties: { title: "A" }, geometry: { type: "Point", coordinates: [13.405, 52.52] } },
      { type: "Feature", id: "b", properties: { title: "B" }, geometry: { type: "LineString", coordinates: [[13.38, 52.51], [13.42, 52.53]] } }
    ]
  }, {
    popup: (feature) => String(feature.properties?.title)
  });

  assert.equal(layer.featureEntries.length, 2);
  for (const entry of layer.featureEntries) assert.ok(entry.layer.getPopup());
});

test("openPopup mounts a chart widget and destroys it on close", () => {
  installDom();

  const chartData = {
    labels: ["Mon", "Tue", "Wed", "Thu", "Fri"],
    datasets: [{ data: [18, 42, 31, 56, 47] }]
  };
  let chartConstructs = 0;
  let chartDestroys = 0;
  let opened = 0;
  let closed = 0;

  class FakeChart {
    constructor(canvas, config) {
      chartConstructs += 1;
      this.canvas = canvas;
      this.config = config;
      assert.equal(config.type, "bar");
      assert.deepEqual(config.data, chartData);
    }
    destroy() {
      chartDestroys += 1;
    }
  }

  const map = createMap(new FakeElement("div"), {
    center: [52.52, 13.405],
    zoom: 10,
    controls: false
  });
  map.on("popupopen", () => { opened += 1; });
  map.on("popupclose", () => { closed += 1; });

  const layer = marker([52.52, 13.405])
    .bindPopup(({ data }) => ({
      mount(container, context) {
        assert.ok(context.latlng);
        assert.deepEqual(data.chartData, chartData);
        const canvas = document.createElement("canvas");
        canvas.className = "popup-chart";
        canvas.width = 300;
        canvas.height = 126;
        container.append(canvas);
        const chart = new FakeChart(canvas, { type: "bar", data: data.chartData });
        return () => chart.destroy();
      }
    }), {
      autoPan: false,
      closeButton: false,
      closeOnClick: false,
      className: "analytics-popup"
    })
    .addTo(map);

  layer.getPopup()?.setContentContext({ data: { chartData } });
  layer.openPopup();

  assert.equal(layer.isPopupOpen(), true);
  assert.equal(opened, 1);
  assert.equal(chartConstructs, 1);
  assert.equal(chartDestroys, 0);

  const popupRoot = map.getPane("popup");
  const canvas = popupRoot?.querySelector?.("canvas");
  assert.ok(canvas);
  assert.equal(canvas.className, "popup-chart");
  assert.equal(canvas.width, 300);

  layer.closePopup();
  assert.equal(layer.isPopupOpen(), false);
  assert.equal(closed, 1);
  assert.equal(chartDestroys, 1);

  map.destroy();
});
