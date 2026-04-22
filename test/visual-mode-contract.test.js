import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMap, marker, icon, Icon, DivIcon, ObjectManager, RemoteObjectManager, MarkerCollection, objectManager } from "../dist/index.js";
import { createMap as createEasyMap } from "../dist/easy-entry.js";
import { Marker as ReactMarker } from "../dist/react/layers.js";
import * as standardBundle from "../dist/orihon.standard.esm.js";
import { DrawHandler } from "../dist/draw/index.js";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement, HTMLImageElement: dom.window.HTMLImageElement,
  HTMLDivElement: dom.window.HTMLDivElement,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
});
after(() => dom.window.close());
const position = { lat: 0, lng: 0 };
function mapFor(t, factory = createMap) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const map = factory(host, { controls: false, center: position, zoom: 3 });
  t.after(() => { map.destroy(); host.remove(); });
  return map;
}

test("Marker rejects competing modes, legacy html and invalid selectors before attachment", () => {
  const image = icon({ iconUrl: "marker.png" });
  for (const options of [
    { icon: image, content: "hidden" }, { icon: image, shape: "circle" },
    { content: "hidden", size: 20 }, { content: "", color: "red" },
    { html: "old" }, { html: undefined }, { icon: null }, { icon: {} },
    { content: null }, { content: {} }, { icon: image, anchor: [1, 2] }, null, []
  ]) assert.throws(() => marker(position, options), TypeError);
  assert.ok(marker(position));
  assert.ok(marker(position, { shape: "circle", size: 20 }));
  assert.ok(marker(position, { content: "", anchor: [0, 0] }));
  assert.ok(marker(position, { icon: image }));
});

test("empty and zero marker content remain explicit safe content", (t) => {
  const map = mapFor(t);
  for (const content of ["", 0, "<img src=x onerror=alert(1)>"]) {
    const layer = marker(position, { content }).addTo(map);
    assert.equal(layer.el.textContent, String(content));
    assert.equal(layer.el.querySelector(".oh-marker-pin"), null);
    assert.equal(layer.el.querySelector("img"), null);
    assert.equal(layer.getContent(), content);
    layer.remove();
  }
  const node = document.createElement("strong");
  node.textContent = "Node content";
  const layer = marker(position, { content: node }).addTo(map);
  assert.equal(layer.el.firstChild, node);
});

test("visual setters switch modes explicitly without replacing the marker or reviving old content", (t) => {
  const map = mapFor(t);
  const layer = marker(position, { content: "before" }).addTo(map);
  const element = layer.el;
  const image = icon({ iconUrl: "marker.png", iconSize: [20, 30], iconAnchor: [5, 6] });
  layer.setIcon(image);
  assert.equal(layer.getContent(), null);
  assert.equal(layer.el.querySelectorAll("img").length, 1);
  layer.setAppearance({ shape: "square", color: "red", size: 18 });
  assert.equal(layer.getIcon(), null);
  assert.ok(layer.el.querySelector(".is-square"));
  assert.equal(layer.el.querySelector("img"), null);
  layer.setContent(0);
  assert.equal(layer.el.textContent, "0");
  layer.setIcon(image).setIcon(null);
  assert.equal(layer.getContent(), null);
  assert.ok(layer.el.querySelector(".is-square"));
  assert.equal(layer.el, element);
  assert.deepEqual([layer.getLatLng().lat, layer.getLatLng().lng], [0, 0]);
});

test("invalid visual updates leave the current mode, DOM and options unchanged", (t) => {
  const map = mapFor(t);
  const layer = marker(position, { content: "retained" }).addTo(map);
  for (const change of [() => layer.setIcon({}), () => layer.setContent(null),
    () => layer.setAppearance({ content: "mixed" }), () => layer.setAppearance({ html: "old" })]) {
    assert.throws(change, TypeError);
    assert.equal(layer.getContent(), "retained");
    assert.equal(layer.getIcon(), null);
    assert.equal(layer.el.textContent, "retained");
  }
});

test("explicit built-in anchor survives rendering and appearance updates", (t) => {
  const map = mapFor(t);
  const layer = marker(position, { shape: "circle", anchor: [3, 4] }).addTo(map);
  assert.deepEqual(layer.options.anchor, [3, 4]);
  layer.setAppearance({ size: 25 }).render();
  assert.deepEqual(layer.options.anchor, [3, 4]);
  layer.setContent("text").setAppearance({ shape: "pin", size: 22 });
  assert.deepEqual(layer.options.anchor, [12, 36], "mode switches reset the old mode's anchor");
});

test("icon factory and direct constructors reject competing image/content modes", () => {
  for (const options of [
    { iconUrl: "x.png", content: "ignored" }, { iconUrl: "x.png", content: "" },
    { iconUrl: null }, { iconUrl: 123 }, { iconUrl: " " }, { content: null },
    { content: "text", shadowUrl: "shadow.png" }, { iconRetinaUrl: "retina.png" },
    { html: "old" }, null, []
  ]) assert.throws(() => icon(options), TypeError);
  assert.throws(() => new Icon({ iconUrl: "x.png", content: "ignored" }), TypeError);
  assert.throws(() => new DivIcon({ iconUrl: "x.png" }), TypeError);
  assert.ok(icon() instanceof DivIcon);
  assert.equal(icon({ content: "" }).createIcon().textContent, "");
  assert.equal(icon({ content: 0 }).createIcon().textContent, "0");
  assert.ok(icon({ iconUrl: "x.png" }) instanceof Icon);
});

test("ObjectManager factory rejects conflicting selectors before subscribing or consuming input", () => {
  let subscriptions = 0;
  let iterations = 0;
  const source = { getSnapshot: () => ({ version: 0, features: [] }), subscribe() { subscriptions++; return () => {}; } };
  const points = { *[Symbol.iterator]() { iterations++; yield position; } };
  const loader = () => [];
  for (const options of [
    { loader, points }, { loader, source }, { points, source },
    { loader: null }, { loader: "url" }, { loader: undefined }, { points: null },
    { points: undefined }, { points: {} }, { debounceMs: 1 }, { replace: true },
    { points, clusterize: true }, { points, clusterRenderer: "dom" }, { points, style: () => ({}) },
    null, []
  ]) assert.throws(() => objectManager(options), TypeError);
  assert.throws(() => new RemoteObjectManager({ loader, source }), TypeError);
  assert.equal(subscriptions, 0);
  assert.equal(iterations, 0);
});

test("ObjectManager factory preserves exact return classes for valid modes", () => {
  const local = objectManager();
  const remote = objectManager({ loader: () => [] });
  const points = objectManager({ points: [position], renderer: "dom" });
  assert.ok(local instanceof ObjectManager);
  assert.equal(local instanceof RemoteObjectManager, false);
  assert.ok(remote instanceof RemoteObjectManager);
  assert.ok(points instanceof MarkerCollection);
  local.destroy();
  remote.destroy();
  points.remove();
});

test("point collection custom content does not inherit competing glyph defaults", (t) => {
  const map = mapFor(t);
  const collection = objectManager({ points: [position], renderer: "dom", marker: { content: "custom" } }).addTo(map);
  assert.equal(map.container.querySelector(".oh-marker").textContent, "custom");
  assert.equal(map.container.querySelector(".oh-marker-pin"), null);
  collection.remove();
  const image = icon({ content: "icon" });
  const second = objectManager({ points: [position], renderer: "dom", marker: { icon: image } }).addTo(map);
  assert.equal(map.container.querySelector(".oh-div-icon").textContent, "icon");
  second.remove();
});

test("manager marker validation precedes source subscriptions and point iteration", () => {
  let touched = false;
  const source = { getSnapshot() { touched = true; }, subscribe() { touched = true; } };
  const points = { *[Symbol.iterator]() { touched = true; yield position; } };
  const invalid = { content: "custom", shape: "circle" };
  assert.throws(() => objectManager({ source, marker: invalid }), TypeError);
  assert.throws(() => objectManager({ points, marker: invalid }), TypeError);
  assert.equal(touched, false);
});

test("Easy marker overloads enforce the same visual contract without leaving ghost layers", (t) => {
  const map = mapFor(t, createEasyMap);
  const count = map.layers.size;
  const options = { icon: icon({ content: "icon" }), content: "mixed" };
  assert.throws(() => map.addMarker({ position, ...options }), TypeError);
  assert.equal(map.layers.size, count);
  assert.equal(map.addMarker({ position, content: "" }).el.textContent, "");
});

test("React validates visual mode props before hook initialization on every render", () => {
  assert.throws(() => ReactMarker({ position, icon: icon({ content: "icon" }), content: "mixed" }), /exactly one visual mode/);
});

test("compressed Standard keeps mode contracts and property compatibility with external Draw", (t) => {
  const map = mapFor(t, standardBundle.createMap);
  const layer = standardBundle.marker(position, { content: "" }).addTo(map);
  assert.equal(layer.el.childNodes.length, 0);
  layer.setIcon(standardBundle.icon({ content: "text" })).setAppearance({ shape: "circle" });
  assert.ok(layer.el.querySelector(".is-circle"));
  assert.throws(() => standardBundle.marker(position, { content: "text", shape: "circle" }), TypeError);
  const draw = new DrawHandler().addTo(map).setMode("point");
  map.destroy();
  assert.equal(map.isDestroyed, true);
  assert.equal(draw.map, null);
  assert.throws(() => draw.addTo(map), { name: "DestroyedError", code: "ERR_DESTROYED" });
  draw.destroy();
});
