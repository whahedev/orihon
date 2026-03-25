import test from "node:test";

import assert from "node:assert/strict";

import { Evented } from "../dist/events.js";

import {

  OBJECT_MANAGER_PALETTE,

  ObjectManager,

  objectManager

} from "../dist/services/object-manager.js";

import { webglPointLayer } from "../dist/layers/webgl-point-layer.js";

class FakeClassList {

  values = new Set();

  add(...names) {

    for (const name of names) this.values.add(name);

  }

  remove(...names) {

    for (const name of names) this.values.delete(name);

  }

  toggle(name, force) {

    if (force === true) this.values.add(name);

    else if (force === false) this.values.delete(name);

    else if (this.values.has(name)) this.values.delete(name);

    else this.values.add(name);

    return this.values.has(name);

  }

  contains(name) {

    return this.values.has(name);

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

      }

    };

    this.attributes = new Map();

    this.listeners = new Map();

    this.className = "";

    this.textContent = "";

    this.title = "";

    this.parent = null;

    if (this.tagName === "CANVAS") {

      this.width = 0;

      this.height = 0;

      this.getContext = () => null;

    }

  }

  appendChild(child) {

    this.children.push(child);

    child.parent = this;

    return child;

  }

  setAttribute(name, value) {

    this.attributes.set(name, String(value));

  }

  getAttribute(name) {

    return this.attributes.get(name) ?? null;

  }

  addEventListener() {}

  removeEventListener() {}

  querySelector(selector) {

    const match = (node) => {

      if (selector.startsWith(".") && String(node.className || "").includes(selector.slice(1))) return node;

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

    createElementNS: (_ns, tag) => new FakeElement(tag),

    getElementById: () => null

  };

  globalThis.window = globalThis.window || { devicePixelRatio: 1 };

}

function createFakeMap(zoom = 10) {

  installDom();

  class FakeMap extends Evented {

    zoom = zoom;

    layers = new Set();

    size = { width: 800, height: 600 };

    pixelOrigin = { x: 0, y: 0 };

    container = new FakeElement("div");

    panes = {

      marker: new FakeElement("div"),

      overlay: new FakeElement("div")

    };

    crs = { code: "EPSG:3857" };

    getBounds() {

      return [({ lat: 50, lng: 10 }), ({ lat: 60, lng: 40 })];

    }

    getPane(name) {

      return this.panes[name] || this.panes.overlay;

    }

    latLngToLayerPoint(value) {

      const lat = Array.isArray(value) ? value[0] : value.lat;

      const lng = Array.isArray(value) ? value[1] : value.lng;

      return { x: lng * 1000, y: -lat * 1000 };

    }

    containerPointToLatLng(value) {

      const x = Array.isArray(value) ? value[0] : value.x;

      const y = Array.isArray(value) ? value[1] : value.y;

      return { lat: -y / 1000, lng: x / 1000 };

    }

    setView() { return this; }

    fitBounds() { return this; }

    addLayer(layer) {

      this.layers.add(layer);

      layer.map = this;

      if (typeof layer.onAdd === "function") {

        try { layer.onAdd(this); } catch { /* canvas/webgl may be unavailable */ }

      }

      return this;

    }

    removeLayer(layer) {

      this.layers.delete(layer);

      if (typeof layer.onRemove === "function") {

        try { layer.onRemove(); } catch { /* ignore */ }

      }

      layer.map = null;

      return this;

    }

    addAttribution() { return this; }

    removeAttribution() { return this; }

  }

  return new FakeMap();

}

test("ObjectState create merge delete and copy semantics", () => {

  const manager = objectManager({ clusterize: false, clusterRenderer: "dom" });

  manager.add({ id: 42, coordinates: { lat: 55.75, lng: 37.61 } });

  manager.setObjectState(42, { alarm: true });

  assert.deepEqual(manager.getObjectState(42), { alarm: true });

  manager.setObjectState(42, { severity: 3 });

  assert.deepEqual(manager.getObjectState(42), { alarm: true, severity: 3 });

  manager.setObjectState(42, { alarm: undefined });

  assert.deepEqual(manager.getObjectState(42), { severity: 3 });

  manager.setObjectState(42, { routeId: null });

  assert.deepEqual(manager.getObjectState(42), { severity: 3, routeId: null });

  const snapshot = manager.getObjectState(42);

  snapshot.severity = 9;

  assert.equal(manager.getObjectState(42).severity, 3);

  manager.removeObjectState(42, "severity");

  assert.deepEqual(manager.getObjectState(42), { routeId: null });

  manager.removeObjectState(42);

  assert.deepEqual(manager.getObjectState(42), {});

  manager.destroy();

});

test("ObjectState invalid id and nested values", () => {

  const manager = objectManager();

  manager.add({ id: 1, coordinates: { lat: 1, lng: 2 } });

  assert.throws(() => manager.setObjectState(999, { alarm: true }), RangeError);

  assert.throws(() => manager.setObjectState(1, { meta: { a: 1 } }), TypeError);

  assert.throws(() => manager.setObjectState(1, { tags: [1, 2] }), TypeError);

  manager.destroy();

});

test("clearObjectStates and remove/clear lifecycle", () => {

  const manager = objectManager({ clusterize: false });

  manager.add([

    { id: 1, coordinates: { lat: 55, lng: 37 } },

    { id: 2, coordinates: { lat: 56, lng: 38 } }

  ]);

  manager.setObjectState(1, { alarm: true });

  manager.setObjectState(2, { tracked: true });

  manager.setSelected(1);

  manager.clearObjectStates();

  assert.deepEqual(manager.getObjectState(1), {});

  assert.deepEqual(manager.getObjectState(2), {});

  assert.equal(manager.getSelectedId(), null);

  manager.setObjectState(1, { alarm: true });

  manager.removeObjects(1);

  assert.deepEqual(manager.getObjectState(1), {});

  manager.setObjectState(2, { alarm: true });

  manager.clear();

  assert.deepEqual(manager.getObjectState(2), {});

  assert.equal(manager.getSelectedId(), null);

  manager.add({ id: 2, coordinates: { lat: 56, lng: 38 } });

  assert.deepEqual(manager.getObjectState(2), {});

  manager.destroy();

});

test("selected and hovered stay exclusive through convenience and state APIs", () => {

  const manager = objectManager({ clusterize: false });

  manager.add([

    { id: 1, coordinates: { lat: 55, lng: 37 } },

    { id: 2, coordinates: { lat: 56, lng: 38 } }

  ]);

  manager.setSelected(1);

  assert.equal(manager.getSelectedId(), 1);

  assert.equal(manager.getObjectState(1).selected, true);

  manager.setObjectState(2, { selected: true });

  assert.equal(manager.getSelectedId(), 2);

  assert.equal(manager.getObjectState(1).selected, undefined);

  assert.equal(manager.getObjectState(2).selected, true);

  manager.setObjectState(2, { selected: false });

  assert.equal(manager.getSelectedId(), null);

  manager.setHovered(1);

  manager.setObjectState(2, { hovered: true });

  assert.equal(manager.getHoveredId(), 2);

  assert.equal(manager.getObjectState(1).hovered, undefined);

  manager.setObjectStates([

    { id: 1, state: { selected: true } },

    { id: 2, state: { selected: true } }

  ]);

  assert.equal(manager.getSelectedId(), 2);

  assert.equal(manager.getObjectState(1).selected, undefined);

  assert.equal(manager.getObjectState(2).selected, true);

  manager.destroy();

});

test("updateObject keeps ObjectState", () => {

  const manager = objectManager({ clusterize: false });

  manager.add({ id: 42, coordinates: { lat: 55.75, lng: 37.61 }, properties: { status: "online" } });

  manager.setObjectState(42, { alarm: true });

  manager.update({ id: 42, coordinates: { lat: 55.76, lng: 37.62 }, properties: { status: "offline" } });

  assert.equal(manager.getObjectState(42).alarm, true);

  assert.equal(manager.getObject(42).properties.status, "offline");

  manager.destroy();

});

test("custom style receives object state zoom selected hovered", () => {

  const calls = [];

  const manager = objectManager({

    clusterize: false,

    clusterRenderer: "dom",

    style: (object, state, context) => {

      calls.push({

        status: object.properties?.status,

        alarm: state.alarm,

        zoom: context.zoom,

        selected: context.selected,

        hovered: context.hovered,

        renderer: context.renderer

      });

      return {

        fill: context.selected ? "#7c3aed" : state.alarm ? "#dc2626" : "#16a34a",

        fillOpacity: 0.5,

        size: context.zoom >= 10 ? 20 : 5

      };

    }

  });

  const map = createFakeMap(12);

  manager.add({ id: 1, coordinates: { lat: 55.75, lng: 37.61 }, properties: { status: "online" } });

  manager.addTo(map);

  manager.setObjectState(1, { alarm: true });

  manager.setSelected(1);

  assert.ok(calls.some((c) => c.alarm === true && c.selected === true && c.zoom === 12 && c.renderer === "dom"));

  manager.destroy();

});

test("DOM and WebGL style resolution stay aligned", () => {
  const style = (object, state, context) => ({
    fill: state.alarm ? "#dc2626" : context.selected ? "#7c3aed" : "#2563eb",
    fillOpacity: state.disabled ? 0.2 : 0.9,
    size: 14
  });
  const dom = objectManager({ clusterize: false, clusterRenderer: "dom", style });
  const webgl = objectManager({ clusterize: false, clusterRenderer: "webgl", style, webglThreshold: 1 });
  const mapDom = createFakeMap(11);
  const mapGl = createFakeMap(11);
  const feature = { id: 7, coordinates: ({ lat: 55.75, lng: 37.61 }), properties: { status: "online" } };
  dom.add(feature);
  webgl.add({ ...feature });
  dom.addTo(mapDom);
  webgl.addTo(mapGl);
  dom.setObjectState(7, { alarm: true, disabled: true });
  webgl.setObjectState(7, { alarm: true, disabled: true });
  dom.setSelected(7);
  webgl.setSelected(7);

  const layer = [...mapGl.layers].find((entry) => entry.getColorBuf);
  assert.ok(layer);
  const colors = layer.getColorBuf();
  assert.ok(colors.length >= 4);
  assert.ok(Math.abs(colors[0] - 220 / 255) < 0.01);
  assert.ok(Math.abs(colors[3] - 0.2) < 0.01);

  const marker = dom.markers.get(7);
  assert.ok(marker?.el);
  assert.equal(marker.el.style.getPropertyValue("--oh-om-color") || marker.el.style.getPropertyValue("--oh-marker-fill"), "#dc2626");
  assert.equal(marker.el.style.opacity, "0.2");
  dom.destroy();
  webgl.destroy();
});

test("legacy styleByCategory palette remains available", () => {

  assert.equal(OBJECT_MANAGER_PALETTE.selected.length, 4);

  const manager = objectManager({ clusterize: false, clusterRenderer: "webgl", styleByCategory: true, webglThreshold: 1 });

  const map = createFakeMap();

  manager.add([

    { id: 1, coordinates: { lat: 55, lng: 37 }, properties: { category: "beta" } },

    { id: 2, coordinates: { lat: 56, lng: 38 }, properties: { alert: true } }

  ]);

  manager.addTo(map);

  manager.setSelected(1);

  const layer = [...map.layers].find((entry) => entry.getColorBuf);

  assert.ok(layer);

  const colors = layer.getColorBuf();

  assert.ok(Math.abs(colors[0] - OBJECT_MANAGER_PALETTE.selected[0]) < 1e-6);

  manager.destroy();

});

test("WebGL setObjectState patches styles without full setData rebuild", () => {

  const manager = objectManager({

    clusterize: false,

    clusterRenderer: "webgl",

    webglThreshold: 1,

    style: (object, state) => ({

      fill: state.alarm ? "#dc2626" : "#2563eb",

      fillOpacity: 1,

      size: state.alarm ? 20 : 8

    })

  });

  const map = createFakeMap();

  manager.add([

    { id: 42, coordinates: { lat: 55.75, lng: 37.61 } },

    { id: 43, coordinates: { lat: 55.76, lng: 37.62 } }

  ]);

  manager.addTo(map);

  const layer = [...map.layers].find((entry) => entry.patchStyles && entry.setData);

  assert.ok(layer);

  let setDataCalls = 0;

  let setColorsCalls = 0;

  let setSizesCalls = 0;

  let patchStylesCalls = 0;

  let patchStylesArgs = null;

  let renderCalls = 0;

  const setData = layer.setData.bind(layer);

  const setColors = layer.setColors.bind(layer);

  const setSizes = layer.setSizes.bind(layer);

  const patchStyles = layer.patchStyles.bind(layer);

  const render = layer.render.bind(layer);

  layer.setData = (...args) => {

    setDataCalls++;

    return setData(...args);

  };

  layer.setColors = (...args) => {

    setColorsCalls++;

    return setColors(...args);

  };

  layer.setSizes = (...args) => {

    setSizesCalls++;

    return setSizes(...args);

  };

  layer.patchStyles = (...args) => {

    patchStylesCalls++;

    patchStylesArgs = args;

    return patchStyles(...args);

  };

  layer.render = (...args) => {

    renderCalls++;

    return render(...args);

  };

  setDataCalls = 0;

  setColorsCalls = 0;

  setSizesCalls = 0;

  patchStylesCalls = 0;

  patchStylesArgs = null;

  renderCalls = 0;

  manager.setObjectState(42, { alarm: true });

  assert.equal(setDataCalls, 0);

  assert.equal(setColorsCalls, 0);

  assert.equal(setSizesCalls, 0);

  assert.equal(patchStylesCalls, 1);

  assert.equal(renderCalls, 1);

  assert.ok(patchStylesArgs);

  const [indices, colors, sizes, count] = patchStylesArgs;

  assert.equal(count, 1);

  assert.equal(indices[0], 0);

  assert.ok(Math.abs(colors[0] - 220 / 255) < 0.01);

  assert.ok(Math.abs(colors[1] - 38 / 255) < 0.01);

  assert.ok(Math.abs(colors[2] - 38 / 255) < 0.01);

  assert.ok(Math.abs(colors[3] - 1) < 1e-6);

  assert.equal(sizes[0], 20);

  manager.destroy();

});

test("WebGL filtered hidden style stays synchronized in the canonical pack", () => {
  let styleCalls = 0;
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    style: (_object, state) => {
      styleCalls++;
      return {
        fill: state.alarm ? "#dc2626" : "#2563eb",
        fillOpacity: 1,
        size: state.alarm ? 20 : 8
      };
    }
  });

  const map = createFakeMap();
  manager.add([
    { id: 42, coordinates: { lat: 55.75, lng: 37.61 } },
    { id: 43, coordinates: { lat: 55.76, lng: 37.62 } }
  ]);
  manager.addTo(map);

  const layer = [...map.layers].find((entry) => entry.getColorBuf && entry.getSizeBuf);
  assert.ok(layer);

  styleCalls = 0;
  manager.setFilter((_object, id) => id === 42);
  assert.equal(styleCalls, 0);

  // Object 43 is not in the current GPU view, but its canonical packed style
  // must still be updated so a later filter does not need a full style rebuild.
  manager.setObjectState(43, { alarm: true });
  assert.equal(styleCalls, 1);

  styleCalls = 0;
  manager.setFilter((_object, id) => id === 43);
  assert.equal(styleCalls, 0);

  const colors = layer.getColorBuf();
  const sizes = layer.getSizeBuf();
  assert.equal(colors.length, 4);
  assert.ok(Math.abs(colors[0] - 220 / 255) < 0.01);
  assert.ok(Math.abs(colors[1] - 38 / 255) < 0.01);
  assert.ok(Math.abs(colors[2] - 38 / 255) < 0.01);
  assert.equal(sizes[0], 20);

  manager.destroy();
});

test("WebGL pass-all filter reuses the active full pack", () => {
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    styleByCategory: false
  });
  const map = createFakeMap();
  manager.add([
    { id: 1, coordinates: { lat: 55.75, lng: 37.61 } },
    { id: 2, coordinates: { lat: 55.76, lng: 37.62 } }
  ]);
  manager.addTo(map);

  const layer = [...map.layers].find((entry) => entry.setPackedData);
  assert.ok(layer);

  // Normalize ObjectManager to the canonical full-pack references first.
  manager.setFilter(null);

  let setPackedDataCalls = 0;
  const setPackedData = layer.setPackedData.bind(layer);
  layer.setPackedData = (...args) => {
    setPackedDataCalls++;
    return setPackedData(...args);
  };

  manager.setFilter(() => true);

  assert.equal(manager.getStats().visibleObjects, 2);
  assert.equal(setPackedDataCalls, 0);

  manager.destroy();
});

test("setObjectStates batch triggers a single WebGL render", () => {

  const manager = objectManager({

    clusterize: false,

    clusterRenderer: "webgl",

    webglThreshold: 1,

    style: (_object, state) => ({

      fill: state.active ? "#16a34a" : "#64748b",

      fillOpacity: 1,

      size: 8

    })

  });

  const map = createFakeMap();

  const objects = Array.from({ length: 1000 }, (_, id) => ({

    id,

    coordinates: ({ lat: 55 + (id % 50) * 0.01, lng: 37 + Math.floor(id / 50) * 0.01 })

  }));

  manager.add(objects);

  manager.addTo(map);

  const layer = [...map.layers].find((entry) => entry.render);

  assert.ok(layer);

  let renderCalls = 0;

  const render = layer.render.bind(layer);

  layer.render = (...args) => {

    renderCalls++;

    return render(...args);

  };

  manager.setObjectStates(

    Array.from({ length: 1000 }, (_, index) => ({

      id: index,

      state: { active: index % 2 === 0 }

    }))

  );

  assert.equal(renderCalls, 1);

  manager.destroy();

});

test("zoom-dependent style updates size without rebuilding spatial index", () => {

  const manager = objectManager({

    clusterize: false,

    clusterRenderer: "webgl",

    webglThreshold: 1,

    style: (_object, _state, { zoom }) => ({

      fill: "#2563eb",

      size: zoom >= 10 ? 20 : 5

    })

  });

  const map = createFakeMap(8);

  manager.add({ id: 1, coordinates: { lat: 55.75, lng: 37.61 } });

  manager.addTo(map);

  const layer = [...map.layers].find((entry) => entry.getSizeBuf);

  assert.ok(layer);

  assert.equal(layer.getSizeBuf()[0], 5);

  const indexBefore = manager.index;

  const sizeBefore = manager.index.size;

  map.zoom = 12;

  manager.render();

  assert.equal(manager.index, indexBefore);

  assert.equal(manager.index.size, sizeBefore);

  assert.equal(layer.getSizeBuf()[0], 20);

  manager.destroy();

});

test("temporal WebGL filtering evaluates custom filter only for indexed candidates", () => {
  let filterCalls = 0;
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false,
    time: { value: (object) => Number(object.properties?.time ?? 0) }
  });
  const map = createFakeMap();

  manager.add(
    Array.from({ length: 64 }, (_, id) => ({
      id,
      coordinates: ({ lat: 55 + id * 0.001, lng: 37 + id * 0.001 }),
      properties: { time: id }
    }))
  );
  manager.addTo(map);

  manager.setFilter(() => {
    filterCalls++;
    return true;
  });

  filterCalls = 0;
  manager.setTimeRange(10, 19);

  assert.equal(manager.getStats().visibleObjects, 10);
  assert.equal(filterCalls, 10);

  manager.setTimeRange(null, null);
  assert.equal(manager.getStats().visibleObjects, 64);

  manager.setFilter(null);
  manager.destroy();
});

test("full temporal WebGL range bypasses the system bitset", () => {
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false,
    time: { value: (object) => Number(object.properties?.time ?? 0) }
  });
  const map = createFakeMap();

  manager.add(
    Array.from({ length: 64 }, (_, id) => ({
      id,
      coordinates: ({ lat: 55 + id * 0.001, lng: 37 + id * 0.001 }),
      properties: { time: id }
    }))
  );
  manager.addTo(map);

  assert.equal(manager._webglSystemMask.length, 0);

  manager.setTimeRange(0, 63);
  assert.equal(manager.getStats().visibleObjects, 64);
  assert.equal(manager._webglSystemMask.length, 0);

  manager.setTimeRange(10, 19);
  assert.equal(manager.getStats().visibleObjects, 10);
  assert.ok(manager._webglSystemMask.length >= 2);

  manager.setTimeRange(null, null);
  manager.destroy();
});

test("initial flat WebGL sync keeps a zero-copy canonical pack", () => {
  const manager = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false
  });
  const map = createFakeMap();

  manager.add([
    { id: 1, coordinates: { lat: 55.1, lng: 37.1 } },
    { id: 2, coordinates: { lat: 55.2, lng: 37.2 } },
    { id: 3, coordinates: { lat: 55.3, lng: 37.3 } }
  ]);
  manager.addTo(map);

  assert.ok(manager._webglSyncProfile);
  assert.equal(manager._webglSyncProfile.points, 3);
  assert.equal(manager._webglSyncProfile.zeroCopyCanonical, true);
  assert.ok(manager._webglPack);
  assert.equal(manager._webglPack.meta, manager._webglMeta);
  assert.equal(manager._webglPack.idToIndex, manager._webglIdToIndex);

  manager.destroy();
});

test("dense numeric WebGL ids use zero-storage slot indexing with sparse fallback", () => {
  const dense = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false
  });
  const denseMap = createFakeMap();
  dense.add([
    { id: 0, coordinates: { lat: 55.1, lng: 37.1 } },
    { id: 1, coordinates: { lat: 55.2, lng: 37.2 } },
    { id: 2, coordinates: { lat: 55.3, lng: 37.3 } }
  ]);
  dense.addTo(denseMap);

  assert.equal(dense._webglSyncProfile?.denseIdIndex, true);
  assert.equal(dense._webglIdToIndex.get(0), 0);
  assert.equal(dense._webglIdToIndex.get(2), 2);
  assert.equal(dense._webglIdToIndex.get(3), undefined);

  dense.setVisibleIds([2]);
  assert.equal(dense.getStats().visibleObjects, 1);
  dense.setVisibleIds(null);
  assert.equal(dense.getStats().visibleObjects, 3);
  dense.destroy();

  const sparse = objectManager({
    clusterize: false,
    clusterRenderer: "webgl",
    webglThreshold: 1,
    sceneFeatures: false,
    styleByCategory: false
  });
  const sparseMap = createFakeMap();
  sparse.add([
    { id: 10, coordinates: { lat: 55.1, lng: 37.1 } },
    { id: 20, coordinates: { lat: 55.2, lng: 37.2 } },
    { id: "object-30", coordinates: { lat: 55.3, lng: 37.3 } }
  ]);
  sparse.addTo(sparseMap);

  assert.equal(sparse._webglSyncProfile?.denseIdIndex, false);
  assert.equal(sparse._webglIdToIndex.get(10), 0);
  assert.equal(sparse._webglIdToIndex.get(20), 1);
  assert.equal(sparse._webglIdToIndex.get("object-30"), 2);
  sparse.destroy();
});

test("objectstatechange skips no-op writes", () => {

  const manager = objectManager();

  manager.add({ id: 1, coordinates: { lat: 1, lng: 2 } });

  let events = 0;

  manager.on("objectstatechange", () => { events++; });

  manager.setObjectState(1, { alarm: true });

  manager.setObjectState(1, { alarm: true });

  assert.equal(events, 1);

  manager.destroy();

});

test("WebGLPointLayer setSizes and patchSize", () => {

  const layer = webglPointLayer(

    [

      { lat: 52.5, lng: 13.4 },

      { lat: 52.51, lng: 13.41 }

    ],

    { pointSize: 4 }

  );

  layer.setSizes([12, 24]);

  assert.equal(layer.getStats().vertexSizes, true);

  assert.equal(layer.getSizeBuf()[0], 12);

  assert.equal(layer.getSizeBuf()[1], 24);

  layer.patchSize(1, 30);

  assert.equal(layer.getSizeBuf()[1], 30);

  layer.setSizes(null);

  assert.equal(layer.getStats().vertexSizes, false);

});

test("public ObjectManager style API surface", () => {

  const manager = new ObjectManager({

    style: () => ({ fill: "#000000", size: 9 })

  });

  assert.equal(typeof manager.setObjectState, "function");

  assert.equal(typeof manager.setObjectStates, "function");

  assert.equal(typeof manager.getObjectState, "function");

  assert.equal(typeof manager.removeObjectState, "function");

  assert.equal(typeof manager.clearObjectStates, "function");

  assert.equal(typeof manager.setStyle, "function");

  assert.equal(typeof manager.setVisibleIds, "function");

  manager.destroy();

});

test("setVisibleIds subsets WebGL draw list from the packed buffer", async () => {

  const map = createFakeMap(6);

  const manager = objectManager({

    clusterize: false,

    clusterRenderer: "webgl",

    webglThreshold: 1,

    sceneFeatures: false,

    styleByCategory: false

  });

  manager.add([

    { id: 0, coordinates: { lat: 52.5, lng: 13.4 } },

    { id: 1, coordinates: { lat: 52.6, lng: 13.5 } },

    { id: 2, coordinates: { lat: 52.7, lng: 13.6 } }

  ]);

  manager.addTo(map);

  await manager.prepareLayout(6);

  manager.setVisibleIds([1]);

  assert.equal(manager.getStats().visibleObjects, 1);

  manager.setVisibleIds(null);

  assert.equal(manager.getStats().visibleObjects, 3);

  manager.destroy();

});

test("point styles use the canonical fill vocabulary in DOM and WebGL", () => {
  const style = () => ({ fill: "#2563eb", fillOpacity: 0.35, size: 12 });
  const dom = objectManager({ clusterize: false, clusterRenderer: "dom", style, styleByCategory: false });
  const webgl = objectManager({ clusterize: false, clusterRenderer: "webgl", style, styleByCategory: false, webglThreshold: 1 });
  const mapDom = createFakeMap();
  const mapGl = createFakeMap();
  dom.add({ id: 1, coordinates: { lat: 55.75, lng: 37.61 } }).addTo(mapDom);
  webgl.add({ id: 1, coordinates: { lat: 55.75, lng: 37.61 } }).addTo(mapGl);

  const marker = dom.markers.get(1);
  assert.equal(marker.el.style.getPropertyValue("--oh-om-color") || marker.el.style.getPropertyValue("--oh-marker-fill"), "#2563eb");
  assert.equal(marker.el.style.opacity, "0.35");

  const pointLayer = [...mapGl.layers].find((entry) => entry.getColorBuf);
  const colors = pointLayer.getColorBuf();
  assert.ok(Math.abs(colors[0] - 37 / 255) < 0.01);
  assert.ok(Math.abs(colors[1] - 99 / 255) < 0.01);
  assert.ok(Math.abs(colors[2] - 235 / 255) < 0.01);
  assert.ok(Math.abs(colors[3] - 0.35) < 0.01);
  dom.destroy();
  webgl.destroy();
});

test("removed point spellings are rejected instead of silently losing to fill", () => {
  // `color` / `opacity` used to be accepted aliases. They are removed: two
  // spellings for one property is exactly the ambiguity this vocabulary drops.
  for (const [legacy, replacement] of [["color", "fill"], ["opacity", "fillOpacity"]]) {
    const manager = objectManager({
      clusterize: false,
      styleByCategory: false,
      style: () => ({ fill: "#2563eb", fillOpacity: 0.35, size: 12, [legacy]: legacy === "color" ? "#dc2626" : 0.9 })
    });
    manager.add({ id: 1, coordinates: { lat: 55.75, lng: 37.61 } });
    assert.throws(
      () => manager.addTo(createFakeMap()),
      new RegExp(`${legacy} was removed from point styles\\. Use ${replacement}\\.`)
    );
    manager.destroy();
  }
});

test("ObjectManager lines use the canonical stroke vocabulary", () => {
  const manager = objectManager({
    clusterize: false,
    styleByCategory: false,
    style: () => ({
      line: { stroke: "#2563eb", strokeOpacity: 0.4, strokeWidth: 7 }
    })
  });
  const map = createFakeMap();
  manager.add({
    id: "route",
    geometry: {
      type: "LineString",
      coordinates: [[37.60, 55.74], [37.64, 55.77]]
    }
  }).addTo(map);
  const pathLayer = [...map.layers].find((entry) => Array.isArray(entry.paths));
  assert.ok(pathLayer);
  // The batch stores the same canonical vocabulary the resolver returns.
  assert.equal(pathLayer.paths[0].style.stroke, "#2563eb");
  assert.equal(pathLayer.paths[0].style.strokeOpacity, 0.4);
  assert.equal(pathLayer.paths[0].style.strokeWidth, 7);
  manager.destroy();
});

test("removed line spellings are rejected on managed line styles", () => {
  for (const [legacy, replacement] of [["color", "stroke"], ["opacity", "strokeOpacity"], ["width", "strokeWidth"]]) {
    const manager = objectManager({
      clusterize: false,
      styleByCategory: false,
      style: () => ({
        line: { stroke: "#2563eb", strokeOpacity: 0.4, strokeWidth: 7, [legacy]: legacy === "color" ? "#dc2626" : 1 }
      })
    });
    manager.add({
      id: "route",
      geometry: { type: "LineString", coordinates: [[37.60, 55.74], [37.64, 55.77]] }
    });
    assert.throws(
      () => manager.addTo(createFakeMap()),
      new RegExp(`${legacy} was removed from line styles\\. Use ${replacement}\\.`)
    );
    manager.destroy();
  }
});

