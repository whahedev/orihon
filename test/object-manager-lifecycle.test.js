import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { objectManager, Evented } from "../dist/index.js";

class FakeMap extends Evented {
  zoom = 1;
  getBounds() { return { south: 0, west: 0, north: 2, east: 2 }; }
}
const point = (id) => ({ id, coordinates: { lat: 1, lng: 1 } });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("detach retains objects, removeObjects deletes records without detaching, remove is absent", () => {
  const map = new FakeMap();
  const manager = objectManager({ minZoom: 10 }).addTo(map).add([point(1), point(2)]);
  manager.removeObjects(1);
  assert.equal(manager.map, map);
  assert.deepEqual(manager.getObjects(), [point(2)]);
  assert.equal(typeof manager.remove, "undefined");
  manager.detach().detach();
  assert.equal(manager.map, null);
  assert.equal(manager.isDestroyed, false);
  assert.deepEqual(manager.getObjects(), [point(2)]);
  manager.addTo(map);
  map.emit("unload");
  assert.equal(manager.map, null);
  assert.deepEqual(manager.getObjects(), [point(2)]);
  manager.destroy().destroy();
  assert.equal(manager.isDestroyed, true);
  assert.deepEqual(manager.getObjects(), []);
});

test("destroyed managers reject data, state and rendering mutations", async () => {
  const manager = objectManager();
  manager.destroy();
  const mutations = [
    () => manager.add(point(1)), () => manager.addTo(new FakeMap()),
    () => manager.update(point(1)), () => manager.updateObjects([point(1)]),
    () => manager.moveObject(1, { lat: 2, lng: 2 }), () => manager.removeObjects(1),
    () => manager.beginBulk(), () => manager.setSceneFeatures(true),
    () => manager.setFilter(null), () => manager.setVisibleIds([]),
    () => manager.setSelected(1), () => manager.setHovered(1),
    () => manager.setObjectState(1, {}), () => manager.setObjectStates([]),
    () => manager.removeObjectState(1), () => manager.clearObjectStates(),
    () => manager.setStyle(null), () => manager.registerIcon("x", "x.png"),
    () => manager.removeIcon("x"), () => manager.clearIcons(),
    () => manager.setTime(1), () => manager.setTimeRange(1, 2),
    () => manager.setVisualization("objects"), () => manager.focusObject(1),
    () => manager.bindPopup("x"), () => manager.bindClusterPopup("x"),
    () => manager.openPopup(1), () => manager.setClusterize(true),
    () => manager.setClusterRadiusPixels(50), () => manager.setClusterRenderer("dom"),
    () => manager.spiderfyCluster("x")
  ];
  for (const mutate of mutations) assert.throws(mutate, { name: "AbortError" });
  await assert.rejects(manager.addAsync([point(1)]), { name: "AbortError" });
  await assert.rejects(manager.prepareLayout(), { name: "AbortError" });
  manager.clear().detach().endBulk().closePopup().unspiderfy();
  manager.render(); // Late scheduled rendering is harmless.
  assert.equal(manager.getStats().objects, 0);
});

test("destroy rejects a blocked async iterator, requests cleanup and ignores late values", async () => {
  const late = deferred();
  let returns = 0;
  const source = {
    [Symbol.asyncIterator]() { return this; },
    next() { return late.promise; },
    return() { returns++; return new Promise(() => {}); }
  };
  const manager = objectManager();
  const pending = manager.addAsync(source, { chunkSize: 1 });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  manager.destroy();
  await rejected;
  assert.equal(returns, 1);
  late.resolve({ value: point(1), done: false });
  await flush();
  assert.equal(manager.getStats().objects, 0);
  assert.equal(returns, 1);
});

test("external import cancellation releases bulk state and preserves accepted prefix", async () => {
  const blocked = deferred();
  const entered = deferred();
  let calls = 0;
  const source = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (++calls === 1) return Promise.resolve({ value: point(1), done: false });
      entered.resolve();
      return blocked.promise;
    },
    return() { throw new Error("cleanup failed"); }
  };
  const controller = new AbortController();
  const manager = objectManager();
  const pending = manager.addAsync(source, { chunkSize: 1, yieldMode: "task", signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(manager._bulkDepth, 0);
  assert.deepEqual(manager.getObjects(), [point(1)]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await manager.addAsync([point(2)], { chunkSize: 1 });
  assert.equal(manager.getStats().objects, 2);
  blocked.reject(new Error("late iterator failure"));
  await flush();
  manager.destroy();
});

test("destroy from progress stops array ingestion and cannot be reentered", async () => {
  const manager = objectManager();
  let progress = 0;
  const pending = manager.addAsync([point(1), point(2)], {
    chunkSize: 1, yieldMode: "task",
    onProgress() { progress++; manager.destroy(); assert.throws(() => manager.add(point(3)), { name: "AbortError" }); }
  });
  await assert.rejects(pending, { name: "AbortError" });
  await flush();
  assert.equal(progress, 1);
  assert.deepEqual(manager.getObjects(), []);
});

test("destroy cancels every concurrent import without affecting another manager", async () => {
  const source = () => ({ [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); } });
  const first = objectManager();
  const second = objectManager();
  const pending = [first.addAsync(source()), first.addAsync(source())];
  const rejected = pending.map((value) => assert.rejects(value, { name: "AbortError" }));
  first.destroy();
  await Promise.all(rejected);
  await second.addAsync([point(1)]);
  await second.prepareLayout();
  assert.equal(second.getStats().objects, 1);
  second.destroy();
});

test("detach keeps source binding; destroy releases it once and ignores captured notifications", () => {
  let notify;
  let unsubscribed = 0;
  const source = { getSnapshot: () => ({ version: 0, features: [] }), subscribe(callback) {
    notify = callback; return () => { unsubscribed++; };
  } };
  const manager = objectManager({ source, minZoom: 10 }).addTo(new FakeMap());
  manager.detach();
  assert.equal(unsubscribed, 0);
  notify({ type: "add", version: 1, features: [{ type: "Feature", id: 1, geometry: { type: "Point", coordinates: [1, 1] } }] });
  assert.equal(manager.getStats().objects, 1);
  manager.destroy().destroy();
  assert.equal(unsubscribed, 1);
  notify({ type: "add", version: 2, features: [{ type: "Feature", id: 2, geometry: { type: "Point", coordinates: [1, 1] } }] });
  assert.equal(manager.getStats().objects, 0);
});

test("destroy before deferred hierarchy dispatch never starts shared worker work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const manager = objectManager({ layoutWorker: true, clusterize: true });
  manager._greedyZoomInlineLimit = 1;
  let calls = 0;
  manager._workerPool = { clusterIndex() { calls++; return new Promise(() => {}); } };
  manager.add([point(1), point(2)]);
  await manager.prepareLayout();
  manager.destroy();
  t.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(manager.getStats().objects, 0);
});

test("late shared-worker failures do not resurrect state or escape as unhandled rejections", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const late = deferred();
  const manager = objectManager({ layoutWorker: true, clusterize: true });
  manager._greedyZoomInlineLimit = 1;
  let calls = 0;
  manager._workerPool = { clusterIndex() { calls++; return late.promise; } };
  manager.add([point(1), point(2)]);
  await manager.prepareLayout();
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  manager.destroy();
  late.reject(new Error("worker failed after teardown"));
  await flush();
  assert.equal(manager.getStats().objects, 0);
});
