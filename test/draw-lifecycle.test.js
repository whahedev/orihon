import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMap } from "../dist/map.js";
import { DrawHandler, drawControl } from "../dist/draw/index.js";
import { featureGroup } from "../dist/layer-group.js";

const point = (lng = 1) => ({ type: "Point", coordinates: [lng, 2] });
const aborted = { name: "AbortError" };

function environment(t) {
  const dom = new JSDOM("<!doctype html><div id='a'></div><div id='b'></div>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const maps = ["a", "b"].map((id) => createMap(id, { controls: false, center: { lat: 0, lng: 0 }, zoom: 3 }));
  const keys = new Set();
  const add = dom.window.addEventListener.bind(dom.window);
  const remove = dom.window.removeEventListener.bind(dom.window);
  dom.window.addEventListener = (type, callback, ...args) => { if (type === "keydown") keys.add(callback); add(type, callback, ...args); };
  dom.window.removeEventListener = (type, callback, ...args) => { if (type === "keydown") keys.delete(callback); remove(type, callback, ...args); };
  t.after(() => {
    for (const map of maps) map.destroy();
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { maps, keys, window: dom.window };
}

test("Draw destruction is terminal, idempotent and releases owned features/history", () => {
  const draw = new DrawHandler().loadData(point());
  draw.on("modechange", () => assert.fail("destroy must not emit modechange"));
  draw.destroy().destroy().remove().cancel();
  assert.equal(draw.isDestroyed, true);
  assert.equal(draw.map, null);
  assert.equal(draw.mode, "off");
  assert.deepEqual(draw.toGeoJSON().features, []);
  assert.equal(draw.listens("modechange"), false);
  for (const mutate of [() => draw.addTo({}), () => draw.setMode("off"), () => draw.finish(),
    () => draw.undo(), () => draw.redo(), () => draw.loadData(point())]) assert.throws(mutate, aborted);
  assert.throws(() => { draw.mode = "point"; }, TypeError);
  assert.throws(() => { draw.map = {}; }, TypeError);
  assert.throws(() => { draw.isDestroyed = false; }, TypeError);
});

test("Draw remove retains data/history, restores behaviors and releases all edit listeners", (t) => {
  const { maps: [map, other], keys } = environment(t);
  map.behaviors.disable("boxZoom");
  const draw = new DrawHandler().addTo(map).loadData(point()).loadData(point(3));
  draw.setMode("edit");
  const layer = draw.featureGroup.getLayers()[0];
  draw.featureGroup.emit("click", { layer });
  const handle = [...map.layers].find((item) => item.options.className?.includes("oh-draw-vertex-handle"));
  assert.ok(handle);
  assert.equal(keys.size, 1);
  assert.equal(map.behaviors.isEnabled("dblClick"), false);
  draw.remove().remove();
  assert.equal(keys.size, 0);
  assert.equal(map.behaviors.isEnabled("dblClick"), true);
  assert.equal(map.behaviors.isEnabled("boxZoom"), false);
  assert.equal(map.hasLayer(draw.featureGroup), false);
  assert.equal(handle.listens("drag"), false);
  handle.emit("drag", { latlng: { lat: 9, lng: 9 } });
  assert.equal(layer.getLatLng().lng, 3);
  draw.addTo(other).undo();
  assert.equal(draw.toGeoJSON().features[0].geometry.coordinates[0], 1);
  draw.redo();
  assert.equal(draw.toGeoJSON().features[0].geometry.coordinates[0], 3);
  assert.equal(keys.size, 1);
  draw.destroy();
  assert.equal(keys.size, 0);
});

test("standalone Draw detaches on map unload and may attach to another live map", (t) => {
  const { maps: [map, other], keys } = environment(t);
  const draw = new DrawHandler().addTo(map).loadData(point()).setMode("circle");
  map.destroy();
  assert.equal(draw.map, null);
  assert.equal(draw.mode, "off");
  assert.equal(draw.isDestroyed, false);
  assert.equal(keys.size, 0);
  assert.equal(draw.toGeoJSON().features.length, 1);
  assert.throws(() => draw.addTo(map), aborted);
  draw.addTo(other).setMode("point");
  assert.equal(other.behaviors.isEnabled("dblClick"), false);
  draw.remove();
  assert.equal(other.behaviors.isEnabled("dblClick"), true);
  draw.destroy();
});

test("caller-owned feature groups and their listeners survive Draw destruction", (t) => {
  const { maps: [map], keys } = environment(t);
  for (const alreadyAttached of [false, true]) {
    const group = featureGroup();
    if (alreadyAttached) group.addTo(map);
    let customEvents = 0;
    group.on("custom", () => customEvents++);
    const draw = new DrawHandler({ featureGroup: group }).addTo(map).loadData(point());
    draw.destroy();
    assert.equal(group.getLayers().length, 1);
    assert.equal(map.hasLayer(group), alreadyAttached);
    assert.equal(group.listens("click"), false);
    group.emit("custom");
    assert.equal(customEvents, 1);
    group.remove().clearLayers();
  }
  assert.equal(keys.size, 0);
});

test("Draw removal rejects legacy destructive options without deleting data", () => {
  for (const draw of [new DrawHandler(), drawControl()]) {
    draw.loadData(point());
    assert.throws(() => draw.remove({ destroyFeatures: true }), /no longer accepts options/);
    assert.equal(draw.toGeoJSON().features.length, 1);
    draw.destroy();
  }
});

test("DrawControl transfers between maps without leaving controls, DOM or subscriptions behind", (t) => {
  const { maps: [map, other], keys } = environment(t);
  const draw = drawControl().addTo(map).loadData(point()).setMode("point");
  const oldButton = draw.el.querySelector(".oh-draw-circle");
  other.addControl(draw);
  assert.equal(map.controls.has(draw), false);
  assert.equal(other.controls.has(draw), true);
  assert.equal(document.querySelectorAll(".oh-draw-control").length, 1);
  assert.equal(keys.size, 1);
  oldButton.click();
  assert.equal(draw.handler.mode, "off");
  draw.destroy().destroy();
  assert.equal(keys.size, 0);
  assert.equal(other.controls.has(draw), false);
  assert.equal(document.querySelectorAll(".oh-draw-control").length, 0);
  assert.equal(draw.isDestroyed, true);
  assert.throws(() => draw.addTo(map), aborted);
  assert.throws(() => map.addControl(draw), aborted);
  assert.equal(map.controls.has(draw), false, "failed onAdd must roll back control registration");
  assert.throws(() => draw.setPosition("top-right"), aborted);
});

test("map-driven DrawControl removal is reusable; destroy is final", (t) => {
  const { maps: [map, other], keys } = environment(t);
  const draw = drawControl().addTo(map).loadData(point()).setMode("edit");
  map.destroy();
  assert.equal(draw.map, null);
  assert.equal(draw.handler.map, null);
  assert.equal(keys.size, 0);
  assert.equal(draw.isDestroyed, false);
  assert.throws(() => draw.addTo(map), aborted);
  draw.addTo(other);
  assert.equal(draw.toGeoJSON().features.length, 1);
  draw.destroy();
});

test("pointercancel discards rectangle/circle drafts instead of committing them", (t) => {
  const { maps: [map], window } = environment(t);
  const draw = new DrawHandler().addTo(map);
  let completed = 0;
  draw.on("drawcomplete", () => completed++);
  for (const mode of ["rectangle", "circle"]) {
    draw.setMode(mode);
    for (const type of ["pointerdown", "pointermove", "pointercancel", "pointerup"]) {
      map.container.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 50, clientY: 50 }));
    }
    assert.equal(draw.featureGroup.getLayers().length, 0);
    assert.equal(map.layers.size, 1, "draft guide must be removed");
  }
  assert.equal(completed, 0);
  draw.destroy();
});

test("destroy/remove/cancel from drawstart cannot commit a stale point or draft", (t) => {
  const { maps: [map], keys } = environment(t);
  for (const action of ["destroy", "remove", "cancel"]) {
    for (const mode of ["point", "polyline", "polygon"]) {
      const draw = new DrawHandler().addTo(map).setMode(mode);
      let completed = 0;
      draw.on("drawcomplete", () => completed++);
      draw.on("drawstart", () => draw[action]());
      map.emit("click", { latlng: { lat: 0, lng: 0 } });
      assert.equal(draw.toGeoJSON().features.length, 0);
      assert.equal(completed, 0);
      draw.destroy();
    }
  }
  assert.equal(map.layers.size, 0);
  assert.equal(keys.size, 0);
});

test("removal inside editstart does not emit a stale active modechange", (t) => {
  const { maps: [map] } = environment(t);
  const draw = new DrawHandler().addTo(map);
  const modes = [];
  draw.on("editstart", () => draw.remove());
  draw.on("modechange", (event) => modes.push(event.mode));
  draw.setMode("edit");
  assert.deepEqual(modes, ["off"]);
  assert.equal(draw.map, null);
  draw.destroy();
});

test("loadData clears obsolete editing handles", (t) => {
  const { maps: [map] } = environment(t);
  const draw = new DrawHandler().addTo(map).loadData(point()).setMode("edit");
  draw.featureGroup.emit("click", { layer: draw.featureGroup.getLayers()[0] });
  const handle = [...map.layers].find((item) => item.options.className?.includes("oh-draw-vertex-handle"));
  assert.ok(handle);
  draw.loadData(point(5));
  assert.equal(handle.listens("drag"), false);
  assert.equal(map.hasLayer(handle), false);
  draw.destroy();
});

test("destroy during layer events cannot resume a Draw import or attachment", (t) => {
  const { maps: [map], keys } = environment(t);
  const draw = new DrawHandler().addTo(map).loadData(point());
  map.once("layerremove", () => draw.destroy());
  draw.loadData({ type: "MultiPoint", coordinates: [[2, 3], [4, 5]] });
  assert.equal(draw.toGeoJSON().features.length, 0);
  assert.equal(keys.size, 0);

  const attaching = new DrawHandler();
  map.once("layeradd", () => attaching.destroy());
  assert.throws(() => attaching.addTo(map), aborted);
  assert.equal(attaching.map, null);
  assert.equal(keys.size, 0);
  assert.equal(map.layers.size, 0);
});

test("failed DrawControl attachment rolls back toolbar and subscriptions", (t) => {
  const { maps: [map], keys } = environment(t);
  const draw = drawControl().loadData({ type: "Feature", properties: { radiusMapUnits: 1 }, geometry: point() });
  assert.throws(() => draw.addTo(map), /radiusMapUnits/);
  assert.equal(map.controls.has(draw), false);
  assert.equal(map.layers.size, 0);
  assert.equal(keys.size, 0);
  assert.equal(draw.map, null);
  assert.equal(draw.handler.map, null);
  assert.equal(document.querySelectorAll(".oh-draw-control").length, 0);
  draw.destroy();
});

test("reentrant attachment from modechange supersedes the outer attachment", (t) => {
  const { maps: [map, other], keys } = environment(t);
  const draw = new DrawHandler().addTo(map).setMode("point");
  draw.once("modechange", () => draw.addTo(map));
  assert.throws(() => draw.addTo(other), aborted);
  assert.equal(draw.map, map);
  assert.equal(keys.size, 1);
  draw.destroy();
  assert.equal(keys.size, 0);
});

test("Draw cannot transfer a caller-attached featureGroup away from its owner map", (t) => {
  const { maps: [map, other], keys } = environment(t);
  const group = featureGroup().addTo(map);
  const draw = new DrawHandler({ featureGroup: group }).addTo(map);
  assert.throws(() => draw.addTo(other), /Remove the supplied featureGroup/);
  assert.equal(draw.map, map);
  assert.equal(group.map, map);
  assert.equal(keys.size, 1);
  draw.destroy();
  assert.equal(group.map, map);
});

test("destruction while removing a guide cannot complete a shape or reactivate a mode", (t) => {
  const { maps: [map] } = environment(t);
  for (const action of ["finish", "setMode"]) {
    const draw = new DrawHandler().addTo(map).setMode("polyline");
    map.emit("click", { latlng: { lat: 0, lng: 0 } });
    map.emit("click", { latlng: { lat: 1, lng: 1 } });
    map.once("layerremove", () => draw.destroy());
    draw[action]("edit");
    assert.equal(draw.mode, "off");
    assert.equal(draw.toGeoJSON().features.length, 0);
    assert.equal(map.layers.size, 0);
  }
});

test("destroy during draft cleanup preserves caller-owned data even inside loadData", (t) => {
  const { maps: [map] } = environment(t);
  const group = featureGroup();
  const draw = new DrawHandler({ featureGroup: group }).addTo(map).loadData(point()).setMode("polyline");
  map.emit("click", { latlng: { lat: 0, lng: 0 } });
  map.once("layerremove", () => draw.destroy());
  draw.loadData(point(5));
  assert.equal(draw.isDestroyed, true);
  assert.equal(group.getLayers().length, 1);
  assert.equal(draw.toGeoJSON().features[0].geometry.coordinates[0], 1);
});
