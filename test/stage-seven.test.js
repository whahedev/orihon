import test from "node:test";
import assert from "node:assert/strict";
import {
  Orihon,
  Evented,
  RemoteObjectManager,
  SearchProvider,
  TrafficLayer,
  objectManager,
  createStraightLineRoutingProvider,
  searchProvider,
  routingLayer,
  trafficLayer
} from "../dist/index.js";

class FakeClassList {
  values = new Set();
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
}

class FakeElement {
  constructor() {
    this.children = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = new Map();
    this.clientWidth = 800;
    this.clientHeight = 600;
  }
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    return child;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
}

globalThis.document = {
  createElement: () => new FakeElement(),
  getElementById: () => null
};
globalThis.window = new FakeElement();
globalThis.requestAnimationFrame = (callback) => {
  callback?.(0);
  return 1;
};

test("Map exposes Yandex-style behavior controls", () => {
  const map = new Orihon(new FakeElement(), {
    controls: false,
    behaviors: { scrollZoom: false }
  });
  const changes = [];
  map.on("behaviorchange", (event) => changes.push(event));

  assert.equal(map.behaviors.isEnabled("drag"), true);
  assert.equal(map.behaviors.isEnabled("scrollZoom"), false);
  map.behaviors.enable("scrollZoom").disable("dblClick");

  assert.deepEqual(map.behaviors.getEnabled().sort(), ["boxZoom", "drag", "pinchZoom", "scrollZoom"].sort());
  assert.equal(changes.length, 2);
  map.destroy();
});

test("RemoteObjectManager loads viewport objects and cancels stale work", async () => {
  class FakeMap extends Evented {
    zoom = 10;
    getBounds() { return { south: 55, west: 37, north: 56, east: 38 }; }
  }

  let calls = 0;
  const manager = objectManager({
    minZoom: 20,
    debounceMs: 0,
    loader: async ({ signal }) => {
      calls++;
      assert.equal(signal.aborted, false);
      return [{ id: `remote-${calls}`, coordinates: { lat: 52.52, lng: 13.405 } }];
    }
  });
  const loads = [];
  manager.on("load", (event) => loads.push(event.objects.length));
  manager.addTo(new FakeMap());
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.ok(manager instanceof RemoteObjectManager);
  assert.equal(calls, 1);
  assert.deepEqual(loads, [1]);
  assert.equal(manager.getStats().objects, 1);
  manager.detach();
});

test("SearchProvider normalizes search, geocode and reverse APIs", async () => {
  const provider = searchProvider([
    { name: "Berlin", center: { lat: 52.520, lng: 13.405 } },
    { name: "Hamburg", center: { lat: 53.551, lng: 9.994 } }
  ]);
  assert.ok(provider instanceof SearchProvider);
  assert.deepEqual((await provider.search("ber")).map((item) => item.name), ["Berlin"]);
  assert.equal((await provider.geocode("ham"))?.name, "Hamburg");
  assert.equal((await provider.reverse({ lat: 1, lng: 2 }))?.name, "1.000000, 2.000000");

  const custom = searchProvider({
    search: () => [{ name: "Only", center: ({ lat: 0, lng: 0 }) }]
  });
  assert.equal((await custom.geocode("x"))?.name, "Only");
});

test("RoutingLayer displays alternatives and exposes selection", async () => {
  const layer = routingLayer({ provider: createStraightLineRoutingProvider(), alternatives: true });
  const routes = await layer.route([{ lat: 52.52, lng: 13.40 }, { lat: 52.55, lng: 13.45 }]);

  assert.equal(routes.length, 2);
  assert.equal(layer.getLayers().length, 2);
  layer.select(1);
  assert.equal(layer.selectedIndex, 1);
  assert.equal(layer.getRoutes()[1].name, "Alternative");
});

test("TrafficLayer tracks state and refresh data time", () => {
  const layer = trafficLayer("/tiles/{z}/{x}/{y}.png");
  const states = [];
  layer.on("statechange", (event) => states.push(event.state));

  layer.emit("tileloadstart");
  assert.equal(layer.getState(), "loading");
  layer.emit("tileload");
  assert.equal(layer.getState(), "ready");
  layer.refresh("2026-08-06T00:00:00Z");

  assert.ok(layer instanceof TrafficLayer);
  assert.equal(layer.getDataTime().toISOString(), "2026-08-06T00:00:00.000Z");
  assert.deepEqual(states, ["loading", "ready"]);
});
