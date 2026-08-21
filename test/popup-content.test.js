import test from "node:test";
import assert from "node:assert/strict";
import {
  Popup,
  circle,
  circleMarker,
  createMap,
  destination,
  geoJSON,
  marker,
  polygon,
  polyline,
  rectangle
} from "../dist/index.js";

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
    this.style = {
      setProperty(name, value) {
        this[name] = String(value);
      },
      getPropertyValue(name) {
        return this[name] ?? "";
      },
      removeProperty(name) {
        delete this[name];
      }
    };
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
        setTransform() {},
        fillRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        stroke() {},
        fill() {},
        setLineDash() {},
        fillText() {},
        fillStyle: "",
        strokeStyle: "",
        globalAlpha: 1,
        lineWidth: 1,
        lineCap: "round",
        lineJoin: "round",
        lineDashOffset: 0,
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
    createElementNS: (_namespace, tag) => new FakeElement(tag),
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

test("SVG polygon opens its popup from a real path DOM click", () => {
  installDom();
  const map = createMap(new FakeElement("div"), { center: [0, 0], zoom: 4, controls: false });
  const layer = polygon([[-5, -5], [-5, 5], [5, 5], [5, -5]])
    .bindPopup("Polygon popup", { autoPan: false })
    .addTo(map);

  layer.path.dispatchEvent({
    type: "click",
    clientX: 400,
    clientY: 300,
    stopPropagation() {}
  });

  assert.equal(layer.isPopupOpen(), true);
  map.destroy();
});

test("all SVG geometry popups open from a pointer tap without a click event", async () => {
  installDom();
  const map = createMap(new FakeElement("div"), { center: [0, 0], zoom: 4, controls: false });
  const layers = [
    polyline([[0, -5], [0, 5]], { interactive: false }),
    polygon([[-5, -5], [-5, 5], [5, 5], [5, -5]], { interactive: false }),
    rectangle([[-4, -4], [4, 4]], { interactive: false }),
    circle([0, 0], 100_000, { interactive: false, geodesic: true }),
    circleMarker([0, 0], { interactive: false, radius: 14 })
  ];

  for (const [index, layer] of layers.entries()) {
    layer.bindPopup(`geometry-${index}`, { autoPan: false }).addTo(map);
    assert.equal(layer.options.interactive, true, "bindPopup enables path interaction");
    assert.equal(
      layer.path.style.pointerEvents,
      layer.constructor.name === "Polyline" ? "visiblePainted" : "all",
      "closed geometries expose their full interior as the interaction target"
    );
    layer.path.dispatchEvent({
      type: "pointerdown",
      button: 0,
      pointerId: 1,
      clientX: 400,
      clientY: 300
    });
    layer.path.dispatchEvent({
      type: "pointerup",
      button: 0,
      pointerId: 1,
      clientX: 401,
      clientY: 301,
      stopPropagation() {}
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(layer.isPopupOpen(), true, `${layer.constructor.name} opens from pointer tap`);
    layer.closePopup();
  }
  map.destroy();
});

test("bindTooltip enables interaction for an initially non-interactive SVG path", () => {
  installDom();
  const layer = polyline([[0, -5], [0, 5]], { interactive: false });

  layer.bindTooltip("Line tooltip");

  assert.equal(layer.options.interactive, true);
});

test("geodesic circle queryHit follows its projected ring at high latitude", () => {
  installDom();
  const map = createMap(new FakeElement("div"), { center: [70, 0], zoom: 4, controls: false });
  const layer = circle([70, 0], 500_000, {
    fill: "#2563eb",
    fillOpacity: 0.2,
    geodesic: true
  }).addTo(map);
  const insideNorth = destination([70, 0], 450_000, 0);

  const hits = map.queryLatLng(insideNorth, { layers: [layer], tolerance: 0 });

  assert.equal(hits[0]?.layer, layer);
  map.destroy();
});

test("an unfilled circle remains hittable across its interior", () => {
  installDom();
  const map = createMap(new FakeElement("div"), { center: [0, 0], zoom: 4, controls: false });
  const layer = circle([0, 0], 100_000).bindPopup("circle").addTo(map);
  const center = map.latLngToContainerPoint([0, 0]);

  assert.equal(layer.options.fill, "none");
  assert.equal(layer.path.style.pointerEvents, "all");
  assert.equal(map.query(center, { layers: [layer], tolerance: 0 })[0]?.layer, layer);
  map.destroy();
});

test("marker popup opens from a pointer tap without a click event", async () => {
  installDom();
  const map = createMap(new FakeElement("div"), { center: [0, 0], zoom: 4, controls: false });
  const layer = marker([0, 0], { interactive: false }).bindPopup("marker", { autoPan: false }).addTo(map);
  assert.equal(layer.options.interactive, true);
  layer.el.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 2, clientX: 400, clientY: 300 });
  layer.el.dispatchEvent({
    type: "pointerup",
    button: 0,
    pointerId: 2,
    clientX: 400,
    clientY: 300,
    stopPropagation() {}
  });
  await new Promise((resolve) => setTimeout(resolve, 1));

  assert.equal(layer.isPopupOpen(), true);
  map.destroy();
});

test("canvas GeoJSON polygon emits feature clicks and opens its popup", () => {
  installDom();
  let selectedFeature;
  const feature = {
    type: "Feature",
    properties: { title: "Canvas polygon" },
    geometry: {
      type: "Polygon",
      coordinates: [[[-5, -5], [5, -5], [5, 5], [-5, 5], [-5, -5]]]
    }
  };
  const layer = geoJSON(feature, {
    renderer: "canvas",
    popup: (clicked) => {
      selectedFeature = clicked;
      return clicked.properties.title;
    },
    popupOptions: { autoPan: false }
  });
  const map = createMap(new FakeElement("div"), { center: [0, 0], zoom: 4, controls: false });
  layer.addTo(map);
  const batch = layer.featureEntries[0].layer;

  batch.canvas.dispatchEvent({
    type: "click",
    clientX: 400,
    clientY: 300,
    stopPropagation() {}
  });

  assert.equal(batch.isPopupOpen(), true);
  assert.equal(selectedFeature, feature);
  map.destroy();
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
