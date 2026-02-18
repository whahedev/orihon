import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { SuggestProvider, SuggestWidget } from "../dist/services/suggest.js";
import { routingLayer } from "../dist/services/routing.js";
import { JSDOM } from "jsdom";

const waypoints = [{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }];
const routeResult = (name) => [{ name, coordinates: waypoints }];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

const services = [
  {
    name: "SuggestProvider",
    create: (provider) => new SuggestProvider((_query, context) => provider(context), { debounceMs: 0 }),
    call: (service, context) => service.suggest("query", context),
    value: (name) => [name]
  },
  {
    name: "RoutingLayer",
    create: (provider) => routingLayer({ provider: (_waypoints, context) => provider(context) }),
    call: (service, context) => service.route(waypoints, context),
    value: routeResult
  }
];

for (const adapter of services) {
  test(`${adapter.name}: cancel settles a non-cooperative provider and permits reuse`, { timeout: 2000 }, async () => {
    const started = deferred();
    const late = deferred();
    let calls = 0;
    const service = adapter.create((context) => {
      if (++calls > 1) return adapter.value("new");
      started.resolve(context.signal);
      return late.promise;
    });
    const external = new AbortController();
    const first = adapter.call(service, { signal: external.signal });
    const rejection = assert.rejects(first, { name: "AbortError" });
    const signal = await started.promise;
    service.cancel();
    service.cancel();
    await rejection;
    assert.equal(signal.aborted, true);
    assert.equal(external.signal.aborted, false);
    assert.equal(getEventListeners(external.signal, "abort").length, 0);
    assert.deepEqual(await adapter.call(service), adapter.value("new"));
    late.reject(new Error("late provider failure must be consumed"));
    await flush();
  });

  test(`${adapter.name}: pre-aborted signals never invoke the provider`, async () => {
    let calls = 0;
    const service = adapter.create(() => { calls++; return []; });
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);
    await assert.rejects(adapter.call(service, { signal: controller.signal }),
      (error) => error.name === "AbortError" && error.cause === reason);
    assert.equal(calls, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test(`${adapter.name}: external abort propagates during work and cleans listeners`, { timeout: 2000 }, async () => {
    const started = deferred();
    const controller = new AbortController();
    const service = adapter.create((context) => {
      started.resolve(context);
      return new Promise(() => {});
    });
    const pending = adapter.call(service, { signal: controller.signal, custom: "forwarded" });
    const rejection = assert.rejects(pending, { name: "AbortError" });
    const context = await started.promise;
    assert.equal(context.custom, "forwarded");
    assert.notEqual(context.signal, controller.signal);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    controller.abort("stop");
    await rejection;
    assert.equal(context.signal.aborted, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test(`${adapter.name}: supersession rejects old work and late results cannot replace new data`, { timeout: 2000 }, async () => {
    const started = deferred();
    const old = deferred();
    let calls = 0;
    const service = adapter.create(() => {
      if (++calls > 1) return adapter.value("new");
      started.resolve();
      return old.promise;
    });
    const first = adapter.call(service);
    const rejected = assert.rejects(first, { name: "AbortError" });
    await started.promise;
    const second = adapter.call(service);
    await rejected;
    assert.deepEqual(await second, adapter.value("new"));
    old.resolve(adapter.value("stale"));
    await flush();
    if (service.getRoutes) assert.equal(service.getRoutes()[0].name, "new");
  });

  test(`${adapter.name}: success, empty results and failures release external listeners`, async () => {
    for (const result of [[], null, undefined, adapter.value("ok")]) {
      const controller = new AbortController();
      const service = adapter.create(() => result);
      assert.deepEqual(await adapter.call(service, { signal: controller.signal }), result ?? []);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
    for (const asyncFailure of [false, true]) {
      const controller = new AbortController();
      const cause = new Error("upstream unavailable");
      const service = adapter.create(() => {
        if (asyncFailure) return Promise.reject(cause);
        throw cause;
      });
      await assert.rejects(adapter.call(service, { signal: controller.signal }), (error) => error === cause);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  });

  test(`${adapter.name}: provider AbortError remains a rejection`, async () => {
    const error = Object.assign(new Error("provider timeout"), { name: "AbortError" });
    const service = adapter.create(() => Promise.reject(error));
    await assert.rejects(adapter.call(service), (actual) => actual === error);
  });

  test(`${adapter.name}: reentrant abort listeners cannot orphan a newer request`, { timeout: 2000 }, async () => {
    const started = deferred();
    let newest;
    let calls = 0;
    const service = adapter.create((context) => {
      if (++calls > 1) return adapter.value("newest");
      context.signal.addEventListener("abort", () => { newest = adapter.call(service); }, { once: true });
      started.resolve();
      return new Promise(() => {});
    });
    const first = adapter.call(service);
    const firstRejected = assert.rejects(first, { name: "AbortError" });
    await started.promise;
    const second = adapter.call(service);
    await assert.rejects(second, { name: "AbortError" });
    await firstRejected;
    assert.deepEqual(await newest, adapter.value("newest"));
    assert.equal(calls, 2);
  });
}

test("SuggestProvider cancels debounce and destroys in-flight non-cooperative work", { timeout: 2000 }, async () => {
  let calls = 0;
  const controller = new AbortController();
  const provider = new SuggestProvider(() => { calls++; return []; }, { debounceMs: 60_000 });
  const pending = provider.suggest("query", { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejected;
  assert.equal(calls, 0);
  assert.deepEqual(await provider.suggest(""), []);
  await assert.rejects(provider.suggest("", { signal: controller.signal }), { name: "AbortError" });
  provider.destroy();
  const started = deferred();
  const active = new SuggestProvider(() => { started.resolve(); return new Promise(() => {}); }, { debounceMs: 0 });
  const request = active.suggest("query");
  const destroyed = assert.rejects(request, { name: "AbortError" });
  await started.promise;
  active.destroy();
  active.destroy();
  await destroyed;
  await assert.rejects(active.suggest("new"), { name: "AbortError" });
});

test("RoutingLayer cancellation retains last success and emits exactly one abort, never load/error", async () => {
  let next = () => routeResult("initial");
  const layer = routingLayer({ provider: () => next() });
  await layer.route(waypoints);
  const layers = layer.getLayers();
  const events = [];
  for (const name of ["loading", "load", "abort", "error"]) layer.on(name, () => events.push(name));
  const late = deferred();
  next = () => late.promise;
  const pending = layer.route(waypoints);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  layer.remove(); // Detached layers may still have provider work.
  await rejected;
  assert.deepEqual(events, ["loading", "abort"]);
  assert.equal(layer.getRoutes()[0].name, "initial");
  assert.deepEqual(layer.getLayers(), layers);
  late.resolve(routeResult("stale"));
  await flush();
  assert.deepEqual(events, ["loading", "abort"]);
  next = () => routeResult("reused");
  await layer.route(waypoints);
  assert.equal(layer.getRoutes()[0].name, "reused");
});

test("RoutingLayer loading listener may cancel synchronously without invoking provider", async () => {
  let calls = 0;
  const layer = routingLayer({ provider: () => { calls++; return []; } });
  layer.on("loading", () => layer.cancel());
  await assert.rejects(layer.route(waypoints), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("RoutingLayer old cleanup cannot clear the active request controller", async () => {
  const layer = routingLayer({ provider: () => new Promise(() => {}) });
  const first = layer.route(waypoints);
  const firstRejected = assert.rejects(first, { name: "AbortError" });
  const second = layer.route(waypoints);
  const secondRejected = assert.rejects(second, { name: "AbortError" });
  await firstRejected;
  layer.cancel();
  await secondRejected;
});

test("SuggestWidget handles current-request cancellation as abort, not a business result or error", async (t) => {
  const dom = new JSDOM("<input id='query' value='query'><ul id='results'></ul>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const provider = new SuggestProvider(() => [], { debounceMs: 60_000 });
  const widget = new SuggestWidget({ input: document.getElementById("query"), list: document.getElementById("results"), provider });
  const events = [];
  for (const name of ["results", "abort", "error"]) widget.on(name, () => events.push(name));
  widget.attach();
  provider.cancel();
  await flush();
  assert.deepEqual(events, ["abort"]);
  widget.attach();
  widget.destroy();
  await flush();
  assert.deepEqual(events, ["abort"]);
  provider.destroy();
});
