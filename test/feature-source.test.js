import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
  url: "http://localhost/"
});

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLImageElement: dom.window.HTMLImageElement,
  Node: dom.window.Node,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback) => { callback(0); return 1; },
  cancelAnimationFrame: () => {}
});
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator
});
dom.window.HTMLCanvasElement.prototype.getContext = () => ({
  clearRect() {},
  fillText() {},
  strokeText() {},
  setTransform() {},
  measureText(text) { return { width: String(text).length * 7 }; },
  font: "",
  textAlign: "left",
  textBaseline: "middle",
  direction: "ltr",
  lineJoin: "round",
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 1
});

const [{ featureSource }, { createMap, geoJSON, textLayer }, { objectManager }] = await Promise.all([
  import("orihon/source"),
  import("orihon/standard"),
  import("orihon")
]);

function point(id, name, coordinates = [37.618423, 55.751244]) {
  return {
    type: "Feature",
    id,
    properties: { name },
    geometry: { type: "Point", coordinates }
  };
}

function container() {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientWidth: { value: 800, configurable: true },
    clientHeight: { value: 600, configurable: true }
  });
  element.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600,
    width: 800, height: 600, x: 0, y: 0, toJSON() {}
  });
  document.body.appendChild(element);
  return element;
}

test("FeatureSource provides stable ids and mutation events", () => {
  assert.throws(() => featureSource([point(undefined, "Missing id")]), /requires feature\.id/);
  const source = featureSource([point("a", "A")]);
  const changes = [];
  const unsubscribe = source.subscribe((change) => changes.push(change));

  const snapA = source.getSnapshot();
  assert.equal(source.getSnapshot(), snapA);
  assert.deepEqual(snapA, { version: 0, features: [source.get("a")] });
  source.addMany([point("b", "B"), point("c", "C")]);
  assert.notEqual(source.getSnapshot(), snapA);
  assert.equal(source.getSnapshot(), source.getSnapshot());
  source.update("a", { properties: { name: "A2" } });
  source.remove(["c", "missing"]);
  source.batch(() => {
    source.add(point("d", "D"));
    source.update(point("b", "B2"));
  });
  source.replace([point("x", "X")]);
  unsubscribe();
  source.clear();

  assert.deepEqual(changes.map((change) => change.type), ["add", "update", "remove", "batch", "reset"]);
  assert.deepEqual(changes.map((change) => change.version), [1, 2, 3, 4, 5]);
  assert.equal(changes[3].type, "batch");
  assert.equal(changes[3].changes[0].type, "add");
  assert.equal(changes[3].changes[0].features[0].id, "d");
  assert.equal(changes[3].changes[1].type, "update");
  assert.equal(changes[3].changes[1].features[0].properties.name, "B2");
  assert.equal(source.version, 6);
  assert.equal(source.size, 0);
});

test("FeatureSource.batch rejects async callbacks after flushing sync work", () => {
  const source = featureSource([point("a", "A")]);
  const changes = [];
  source.subscribe((change) => changes.push(change));
  assert.throws(() => source.batch(async () => {
    source.update("a", { properties: { name: "A2" } });
  }), /synchronous/);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, "batch");
  assert.equal(source.get("a").properties.name, "A2");
});

test("GeoJSONLayer applies source deltas without rebuilding untouched layers", () => {
  const source = featureSource([point("a", "A"), point("b", "B")]);
  const map = createMap(container(), {
    center: { lat: 55.751244, lng: 37.618423 },
    zoom: 12,
    controls: false
  });
  const shapes = geoJSON(source, { renderer: "svg" }).addTo(map);
  const layerB = shapes.featureEntries.find((entry) => entry.feature.id === "b")?.layer;
  assert.ok(layerB);

  source.update("a", { properties: { name: "A2" } });
  assert.equal(shapes.featureEntries.find((entry) => entry.feature.id === "b")?.layer, layerB);
  assert.equal(shapes.data.features.find((feature) => feature.id === "a")?.properties?.name, "A2");

  source.add(point("c", "C"));
  assert.equal(shapes.featureEntries.find((entry) => entry.feature.id === "b")?.layer, layerB);
  assert.equal(shapes.data.features.length, 3);

  source.remove("c");
  assert.equal(shapes.data.features.length, 2);
  assert.equal(shapes.featureEntries.find((entry) => entry.feature.id === "b")?.layer, layerB);

  shapes.remove();
  map.destroy();
});

test("one FeatureSource drives GeoJSON, TextLayer and ObjectManager", () => {
  const source = featureSource([point("moscow", "Москва")]);
  const map = createMap(container(), {
    center: { lat: 55.751244, lng: 37.618423 },
    zoom: 12,
    controls: false
  });
  const shapes = geoJSON(source).addTo(map);
  const labels = textLayer(source, { text: (feature) => String(feature.properties?.name ?? "") }).addTo(map);
  const manager = objectManager({ source });

  assert.equal(shapes.data.features.length, 1);
  assert.equal(labels.getVisibleLabels()[0]?.text, "Москва");
  assert.equal(manager.getObject("moscow")?.properties?.name, "Москва");
  manager.setObjectState("moscow", { alarm: true });

  source.batch(() => {
    source.update("moscow", {
      properties: { name: "Moscow" },
      geometry: { type: "Point", coordinates: [37.62, 55.76] }
    });
    source.add(point("berlin", "Berlin", [13.405, 52.52]));
  });

  assert.equal(shapes.data.features.length, 2);
  assert.equal(shapes.data.features.find((feature) => feature.id === "moscow")?.properties?.name, "Moscow");
  assert.equal(labels.getVisibleLabels().some((label) => label.text === "Moscow"), true);
  assert.equal(manager.getObject("moscow")?.properties?.name, "Moscow");
  assert.equal(manager.getObject("berlin")?.properties?.name, "Berlin");
  assert.equal(manager.getObjectState("moscow").alarm, true);

  source.remove("berlin");
  assert.equal(shapes.data.features.length, 1);
  assert.equal(manager.getObject("berlin"), undefined);

  shapes.remove();
  labels.remove();
  manager.destroy();
  map.destroy();
});
