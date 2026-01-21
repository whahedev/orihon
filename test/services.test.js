import test from "node:test";
import assert from "node:assert/strict";
import { Evented } from "../dist/events.js";
import { ObjectManager } from "../dist/services/object-manager.js";
import { SuggestProvider } from "../dist/services/suggest.js";

test("SuggestProvider settles a superseded request", async () => {
  const provider = new SuggestProvider(async (query) => [query], { debounceMs: 5 });
  const first = provider.suggest("first");
  const second = provider.suggest("second");
  assert.deepEqual(await first, []);
  assert.deepEqual(await second, ["second"]);
});

test("SuggestProvider destroy aborts pending work and is terminal", async () => {
  const provider = new SuggestProvider(async (query) => [query], { debounceMs: 50 });
  const pending = provider.suggest("pending");
  provider.destroy();
  provider.destroy();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(provider.suggest("ignored"), { name: "AbortError" });
});

test("ObjectManager detaches map listeners on remove", () => {
  class FakeMap extends Evented {
    zoom = 10;
    getBounds() {
      return { south: -1, west: -1, north: 1, east: 1 };
    }
    latLngToLayerPoint() {
      return { x: 0, y: 0 };
    }
    containerPointToLatLng(value) {
      return { lat: Number(value[1] ?? value.y ?? 0), lng: Number(value[0] ?? value.x ?? 0) };
    }
  }

  const map = new FakeMap();
  const manager = new ObjectManager();
  let renders = 0;
  const render = manager.render.bind(manager);
  manager.render = () => {
    renders++;
    return render();
  };

  manager.addTo(map);
  const afterAdd = renders;
  map.emit("moveend");
  assert.equal(renders, afterAdd + 1);
  manager.remove();
  map.emit("moveend");
  map.emit("zoomend");
  assert.equal(renders, afterAdd + 1);
});
