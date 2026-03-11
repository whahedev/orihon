import test, { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createMap, marker, featureGroup, LatLng, Point, RoutingLayer, ObjectManager,
  polyline, popup, tooltip, imageOverlay, TileLayer, VectorTileLayer, TrafficLayer } from "../dist/index.js";
import { drawControl } from "../dist/draw/index.js";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, Node: dom.window.Node,
  HTMLElement: dom.window.HTMLElement,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window)
});
after(() => dom.window.close());
function mapFor(t) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const map = createMap(host, { controls: false, center: { lat: 0, lng: 0 }, zoom: 3 });
  t.after(() => { map.destroy(); host.remove(); });
  return map;
}

test("built-in map/marker events match the declared fields and propagation targets", (t) => {
  const map = mapFor(t);
  let click;
  map.once("click", (event) => { click = event; });
  const originalEvent = new dom.window.MouseEvent("click", { clientX: 10, clientY: 15, bubbles: true });
  map.container.dispatchEvent(originalEvent);
  assert.equal(click.target, map);
  assert.equal(click.originalEvent, originalEvent);
  assert.ok(click.latlng instanceof LatLng);
  assert.ok(click.containerPoint instanceof Point);
  assert.equal(click.detail.latlng, click.latlng);
  const pin = marker({ lat: 1, lng: 2 });
  const group = featureGroup([pin]);
  let added, removed, pinClick, groupClick;
  pin.once("add", (event) => { added = event; });
  pin.once("remove", (event) => { removed = event; });
  group.addTo(map);
  pin.once("click", (event) => { pinClick = event; });
  group.once("click", (event) => { groupClick = event; });
  pin.el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(pinClick.target, pin);
  assert.equal(groupClick.target, group);
  assert.equal(groupClick.sourceTarget, pin);
  assert.equal(groupClick.layer, pin);
  assert.ok(groupClick.latlng instanceof LatLng);
  group.remove();
  assert.equal(added.map, map);
  assert.equal(removed.detail.map, map);
});

test("DrawControl listeners receive DrawHandler events and preserve off identity", (t) => {
  const map = mapFor(t);
  const control = drawControl().addTo(map);
  t.after(() => control.destroy());
  let mode, complete, count = 0;
  const callback = () => count++;
  control.on("modechange", callback).off("modechange", callback);
  control.once("modechange", (event) => { mode = event; });
  control.once("drawcomplete", (event) => { complete = event; });
  control.setMode("point");
  map.container.dispatchEvent(new dom.window.MouseEvent("click", { clientX: 20, clientY: 30, bubbles: true }));
  assert.equal(mode.target, control.handler);
  assert.equal(mode.mode, "point");
  assert.equal(mode.detail.previous, "off");
  assert.equal(count, 0);
  assert.equal(complete.target, control.handler);
  assert.equal(complete.geojson.type, "Feature");
  assert.equal(complete.geojson.geometry.type, "Point");
  assert.equal(complete.layer, control.handler.featureGroup.getLayers()[0]);
});

test("routing emits route/waypoint payloads and retains arbitrary provider errors", async () => {
  const routing = new RoutingLayer({ provider: () => [{ coordinates: [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }] }] });
  const events = [];
  for (const name of ["loading", "load", "select"]) routing.on(name, (event) => events.push(event));
  const routes = await routing.route([{ latlng: { lat: 0, lng: 0 } }, { latlng: { lat: 1, lng: 1 } }]);
  const loaded = events.find((event) => event.type === "load");
  assert.equal(loaded.routes, routes);
  assert.equal(loaded.waypoints.length, 2);
  assert.equal(loaded.target, routing);
  routing.select(0);
  assert.equal(events.at(-1).route, routes[0]);
  const failure = { providerCode: 503 };
  const broken = new RoutingLayer({ provider: () => { throw failure; } });
  let error;
  broken.once("error", (event) => { error = event; });
  await assert.rejects(broken.route(loaded.waypoints), (value) => value === failure);
  assert.equal(error.error, failure);
  assert.equal(error.detail.error, failure);
});

test("ObjectManager state events expose copied state and changed keys", () => {
  const manager = new ObjectManager();
  manager.add([{ id: "pin", coordinates: { lat: 1, lng: 2 } }]);
  let change;
  manager.once("objectstatechange", (event) => { change = event; });
  manager.setObjectState("pin", { selected: true });
  assert.equal(change.target, manager);
  assert.equal(change.id, "pin");
  assert.deepEqual(change.changedKeys, ["selected"]);
  assert.equal(change.state, change.detail.state);
  assert.equal(change.state.selected, true);
  change.state.selected = false;
  assert.equal(manager.getObjectState("pin").selected, true);
  manager.destroy();
});

test("SVG path click events carry geographic instances and the original DOM event", (t) => {
  const map = mapFor(t);
  const layer = polyline([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }], { interactive: true }).addTo(map);
  let click;
  layer.once("click", (event) => { click = event; });
  const original = new dom.window.MouseEvent("click", { clientX: 20, clientY: 30, bubbles: true });
  layer.path.dispatchEvent(original);
  assert.equal(click.target, layer);
  assert.equal(click.originalEvent, original);
  assert.ok(click.latlng instanceof LatLng);
  assert.equal(click.detail.latlng, click.latlng);
});

test("popup/tooltip lifecycle events distinguish map notifications and detached close", (t) => {
  const map = mapFor(t);
  for (const [factory, prefix] of [[popup, "popup"], [tooltip, "tooltip"]]) {
    const layer = factory("text", { autoPan: false, closeOnClick: false }).setLatLng({ lat: 0, lng: 0 });
    let opened, closed, mapOpen, mapClose;
    layer.once("open", (event) => { opened = event; });
    layer.once("close", (event) => { closed = event; });
    map.once(`${prefix}open`, (event) => { mapOpen = event; });
    map.once(`${prefix}close`, (event) => { mapClose = event; });
    layer.addTo(map).remove();
    assert.equal(opened.target, layer);
    assert.equal(opened.map, map);
    assert.equal(closed.map, map);
    assert.equal(mapOpen.target, map);
    assert.equal(mapOpen[prefix], layer);
    assert.equal(mapClose[prefix], layer);
    layer.once("close", (event) => { closed = event; });
    layer.onRemove();
    assert.equal(closed.map, null);
  }
});

test("content failures retain arbitrary errors and image errors retain their URL", (t) => {
  const map = mapFor(t);
  const failure = { code: "content-unavailable" };
  const layer = popup(() => { throw failure; }, { autoPan: false, closeOnClick: false }).setLatLng({ lat: 0, lng: 0 });
  let contentError;
  layer.once("contenterror", (event) => { contentError = event; }).addTo(map);
  assert.equal(contentError.error, failure);
  const image = imageOverlay("broken.png", [{ lat: -1, lng: -1 }, { lat: 1, lng: 1 }], { interactive: true }).addTo(map);
  let error, click;
  image.once("error", (event) => { error = event; });
  image.once("click", (event) => { click = event; });
  const original = new dom.window.Event("error");
  image.image.dispatchEvent(original);
  image.image.dispatchEvent(new dom.window.MouseEvent("click", { clientX: 10, clientY: 15 }));
  assert.equal(error.originalEvent, original);
  assert.equal(error.url, "broken.png");
  assert.equal(error.target, image);
  assert.ok(click.latlng instanceof LatLng);
});

test("DOM raster events include tiles and Traffic inherits those fields", (t) => {
  const map = mapFor(t);
  for (const Type of [TileLayer, TrafficLayer]) {
    const layer = new Type("tile-{z}-{x}-{y}.png", { maxZoom: 3, keepBuffer: 0 });
    let started, loaded, failed, state;
    layer.once("tileloadstart", (event) => { started = event; });
    layer.once("tileload", (event) => { loaded = event; });
    layer.once("tileerror", (event) => { failed = event; });
    layer.on("statechange", (event) => { state = event; });
    layer.addTo(map);
    assert.ok(started.tile instanceof dom.window.HTMLImageElement);
    started.tile.dispatchEvent(new dom.window.Event("error"));
    assert.equal(failed.url, started.tile.src);
    assert.equal(failed.tile, started.tile);
    assert.equal(failed.error, undefined);
    if (Type === TrafficLayer) {
      assert.equal(state.state, "error");
      assert.equal(state.dataTime, null);
      assert.equal(state.target, layer);
    }
    // A separate load exercises the successful native image path.
    layer.redraw();
    const pending = [...layer.tiles.values()].find((tile) => tile.started);
    pending.el.dispatchEvent(new dom.window.Event("load"));
    assert.equal(loaded.target, layer);
    assert.equal(loaded.z, 3);
    assert.equal(loaded.detail.tile, pending.el);
    layer.remove();
  }
});

test("vector tile events keep nested coordinates and arbitrary provider failures", async (t) => {
  const map = mapFor(t);
  map.setZoom(0);
  const failure = { code: "provider-unavailable" };
  for (const broken of [false, true]) {
    const layer = new VectorTileLayer({ maxZoom: 0, buffer: 0, provider: () => {
      if (broken) throw failure;
      return [];
    } });
    let started, settled;
    layer.once("tileloadstart", (event) => { started = event; });
    layer.once(broken ? "tileerror" : "tileload", (event) => { settled = event; });
    layer.addTo(map);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled.target, layer);
    assert.equal(settled.coordinates, started.coordinates);
    assert.equal(settled.coordinates.z, 0);
    assert.ok(settled.coordinates.signal instanceof AbortSignal);
    if (broken) assert.equal(settled.error, failure);
    else assert.deepEqual(settled.features, []);
    layer.remove();
  }
});
