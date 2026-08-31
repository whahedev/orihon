import test from "node:test";
import assert from "node:assert/strict";
import {
  Bounds,
  FeatureGroup,
  LatLngBounds,
  Layer,
  Point,
  bounds,
  featureGroup,
  latLng,
  lngLat,
  point
} from "../dist/full-entry.js";

test("geometry classes keep value semantics", () => {
  const source = point([10, 20]);
  assert.ok(source instanceof Point);
  assert.deepEqual(source.add([5, -2]).toArray(), [15, 18]);
  assert.deepEqual(source.subtract({ x: 3, y: 4 }).toArray(), [7, 16]);
  assert.equal(source.distanceTo([13, 24]), 5);

  const pixels = new Bounds([0, 0], [100, 50]);
  assert.deepEqual(pixels.getCenter().toArray(), [50, 25]);
  assert.equal(pixels.contains([10, 10]), true);

  const position = latLng({ lat: 52.52, lng: 13.405 });
  const mapLibrePosition = lngLat(13.405, 52.52);
  assert.ok(mapLibrePosition.equals(position));
  assert.deepEqual([mapLibrePosition.lat, mapLibrePosition.lng], [52.52, 13.405]);
  assert.equal(position.clone().equals(position), true);
  const geographic = bounds({ lat: 52, lng: 13 }, { lat: 53, lng: 14 });
  assert.ok(geographic instanceof LatLngBounds);
  assert.equal(geographic.contains(position), true);
  assert.equal(geographic.toBBoxString(), "13,52,14,53");
});

test("FeatureGroup propagates child events and combines bounds", () => {
  class BoundedLayer extends Layer {
    constructor(bounds) {
      super();
      this.value = bounds;
    }
    getBounds() {
      return this.value;
    }
  }

  const first = new BoundedLayer(bounds({ lat: 10, lng: 20 }, { lat: 11, lng: 21 }));
  const second = new BoundedLayer(bounds({ lat: -2, lng: 5 }, { lat: 3, lng: 30 }));
  const group = featureGroup([first, second]);
  assert.ok(group instanceof FeatureGroup);
  assert.equal(group.getLayers().length, 2);
  assert.equal(group.getBounds().toBBoxString(), "5,-2,30,11");

  let event;
  group.on("select", (next) => { event = next; });
  first.emit("select", { value: 42 });
  assert.equal(event.target, group);
  assert.equal(event.sourceTarget, first);
  assert.equal(event.layer, first);
  assert.equal(event.value, 42);

  group.removeLayer(first);
  event = null;
  first.emit("select");
  assert.equal(event, null);
});
