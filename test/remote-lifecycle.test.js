import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { JSDOM } from "jsdom";
import { Evented, objectManager, createMap } from "../dist/index.js";

class FakeMap extends Evented {
  zoom = 10;
  getBounds() { return { south: 1, west: 2, north: 3, east: 4 }; }
}
const objects = (id) => [{ id, coordinates: { lat: 2, lng: 3 } }];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t, loader, options = {}) {
  const map = new FakeMap();
  const manager = objectManager({ minZoom: 20, debounceMs: 60_000, loader, ...options }).addTo(map);
  t.after(() => manager.destroy());
  return { map, manager };
}

test("remote reload is awaitable, immediate, forwards viewport and replaces/appends data", async (t) => {
  for (const replace of [true, false]) {
    const contexts = [];
    const { manager, map } = fixture(t, (context) => { contexts.push(context); return objects("new"); }, { replace });
    manager.add(objects("old"));
    const pending = manager.reload();
    assert.equal(manager.loading, true);
    assert.deepEqual(await pending, objects("new"));
    assert.equal(manager.loading, false);
    assert.equal(contexts[0].reason, "reload");
    assert.deepEqual(contexts[0].bounds, map.getBounds());
    assert.equal(contexts[0].zoom, map.zoom);
    assert.equal(manager.getStats().objects, replace ? 1 : 2);
  }
});

test("remote cancel promptly rejects ignored signals, retains data and cleans external listeners", async (t) => {
  let signal;
  const { manager } = fixture(t, (context) => { signal = context.signal; return new Promise(() => {}); });
  manager.add(objects("old"));
  const external = new AbortController();
  const pending = manager.reload({ signal: external.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  manager.cancel();
  manager.cancel();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(external.signal.aborted, false);
  assert.equal(manager.loading, false);
  assert.equal(getEventListeners(external.signal, "abort").length, 0);
  assert.deepEqual(manager.getObject("old"), objects("old")[0]);
});

test("external abort works before and during remote loading without invoking a pre-aborted loader", async (t) => {
  let calls = 0;
  const { manager } = fixture(t, () => { calls++; return new Promise(() => {}); });
  const external = new AbortController();
  external.abort("reason");
  await assert.rejects(manager.reload({ signal: external.signal }), (error) => error.name === "AbortError" && error.cause === "reason");
  assert.equal(calls, 0);
  const active = new AbortController();
  const pending = manager.reload({ signal: active.signal });
  active.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
});

test("viewport changes invalidate old responses before the debounce delay", async (t) => {
  const late = deferred();
  let signal;
  const { manager, map } = fixture(t, (context) => { signal = context.signal; return late.promise; });
  manager.add(objects("old"));
  const events = [];
  for (const type of ["load", "abort", "error"]) manager.on(type, () => events.push(type));
  const pending = manager.reload();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  map.emit("moveend");
  assert.equal(signal.aborted, true);
  await rejected;
  late.resolve(objects("stale"));
  await flush();
  assert.deepEqual(events, ["abort"]);
  assert.equal(manager.getObject("stale"), undefined);
  assert.equal(manager.getStats().objects, 1);
});

test("supersession protects newer loading state and ignores late resolve/reject", async (t) => {
  for (const fail of [false, true]) {
    const firstResult = deferred();
    const secondResult = deferred();
    let calls = 0;
    const { manager } = fixture(t, () => ++calls === 1 ? firstResult.promise : secondResult.promise);
    const first = manager.reload();
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    const second = manager.reload();
    await firstRejected;
    assert.equal(manager.loading, true);
    if (fail) firstResult.reject(new Error("late failure"));
    else firstResult.resolve(objects("stale"));
    await flush();
    assert.equal(manager.loading, true);
    secondResult.resolve(objects("new"));
    await second;
    assert.equal(manager.loading, false);
    assert.equal(manager.getObject("stale"), undefined);
    assert.equal(manager.getStats().objects, 1);
  }
});

test("remote failures reject with original cause and preserve stored data", async (t) => {
  const error = new Error("provider failed", { cause: new Error("root cause") });
  for (const loader of [() => { throw error; }, () => Promise.reject(error), () => ({ bad: true }),
    () => [null], () => [{ id: "bad", coordinates: [2, 3] }]]) {
    const { manager } = fixture(t, loader);
    manager.add(objects("old"));
    const errors = [];
    manager.on("error", (event) => errors.push(event.error));
    await assert.rejects(manager.reload(), (actual) => {
      assert.equal(errors[0], actual);
      return true;
    });
    assert.equal(manager.loading, false);
    assert.deepEqual(manager.getObject("old"), objects("old")[0]);
    assert.equal(manager.getStats().objects, 1);
  }
});

test("remove detaches listeners and rejects work but allows reattachment", async (t) => {
  let calls = 0;
  const { manager, map } = fixture(t, () => { calls++; return new Promise(() => {}); });
  const pending = manager.reload();
  manager.remove();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(manager.map, null);
  await assert.rejects(manager.reload(), /attached map/);
  for (const name of ["moveend", "zoomend", "resize", "unload"]) map.emit(name);
  await flush();
  assert.equal(calls, 1);
  manager.addTo(new FakeMap());
  const next = manager.reload();
  manager.cancel();
  await assert.rejects(next, { name: "AbortError" });
  assert.equal(calls, 2);
});

test("destroy rejects pending work and remote entrypoints cannot revive the manager", async (t) => {
  let calls = 0;
  const { manager, map } = fixture(t, () => { calls++; return new Promise(() => {}); });
  const pending = manager.reload();
  manager.destroy();
  manager.destroy();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(manager.reload(), { name: "AbortError" });
  assert.throws(() => manager.addTo(map), { name: "AbortError" });
  assert.equal(manager.loading, false);
  map.emit("moveend");
  assert.equal(calls, 1);
});

test("automatic loads report failures through events without unhandled rejection", { timeout: 2000 }, async (t) => {
  const error = new Error("automatic failure");
  const { manager } = fixture(t, () => Promise.reject(error), { debounceMs: 0 });
  const received = await new Promise((resolve) => manager.on("error", resolve));
  assert.equal(received.error, error);
  assert.equal(received.context.reason, "add");
  assert.equal(manager.loading, false);
});

test("loading listeners can cancel synchronously without starting the remote loader", async (t) => {
  let calls = 0;
  const { manager } = fixture(t, () => { calls++; return []; });
  manager.on("loading", () => manager.cancel());
  await assert.rejects(manager.reload(), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("cancel clears queued automatic loads and invalid debounce is rejected", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { manager, map } = fixture(t, () => { calls++; return []; });
  manager.cancel();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 0);
  map.emit("moveend");
  manager.remove();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 0);
  for (const debounceMs of [-1, NaN, Infinity, "120"]) {
    assert.throws(() => objectManager({ loader: () => [], debounceMs }), RangeError);
  }
});

test("null/undefined remote results are successful empty loads, not cancellation", async (t) => {
  for (const result of [[], null, undefined]) {
    const { manager } = fixture(t, () => result);
    manager.add(objects("old"));
    const external = new AbortController();
    assert.deepEqual(await manager.reload({ signal: external.signal }), []);
    assert.equal(manager.getStats().objects, 0);
    assert.equal(manager.loading, false);
    assert.equal(getEventListeners(external.signal, "abort").length, 0);
  }
});

test("reentrant cancellation cannot orphan a newer remote reload", async (t) => {
  let calls = 0;
  let newest;
  const { manager } = fixture(t, ({ signal }) => {
    if (++calls > 1) return objects("newest");
    signal.addEventListener("abort", () => { newest = manager.reload(); }, { once: true });
    return new Promise(() => {});
  });
  const first = manager.reload();
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = manager.reload();
  await assert.rejects(second, { name: "AbortError" });
  await rejected;
  await newest;
  assert.equal(calls, 2);
  assert.equal(manager.getObject("newest").id, "newest");
});

test("destroying a real map detaches its remote manager and cancels pending work", async (t) => {
  const dom = new JSDOM("<div id='map'></div>");
  const original = new Map();
  for (const [key, value] of Object.entries({ document: dom.window.document, window: dom.window,
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} })) {
    original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const map = createMap("map", { controls: false });
  const manager = objectManager({ loader: () => new Promise(() => {}), debounceMs: 60_000 }).addTo(map);
  let unloads = 0;
  map.on("unload", () => { unloads++; map.destroy(); });
  const pending = manager.reload();
  map.destroy();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(unloads, 1);
  assert.equal(manager.map, null);
  assert.equal(manager.loading, false);
  assert.throws(() => manager.addTo(map), { name: "AbortError" });
  manager.destroy();
});
