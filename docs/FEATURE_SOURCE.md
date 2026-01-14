# FeatureSource

`orihon/source` is a small renderer-independent container for GeoJSON Features. Canonical GeoJSON `feature.id` values provide identity, while versioned snapshots and delta events notify any number of consumers without introducing a MapLibre-style map source registry.

```ts
import { createFeatureSource } from "orihon/source";
import { geoJSON, textLayer } from "orihon/standard";
import { objectManager } from "orihon";

const vehicles = createFeatureSource(featureCollection);

geoJSON(vehicles).addTo(map);
textLayer(vehicles, {
  text: feature => String(feature.properties?.name ?? "")
}).addTo(map);

const managedVehicles = objectManager({
  source: vehicles,
  clusterize: true,
  clusterRenderer: "auto"
}).addTo(map);
```

All three consumers receive the same changes:

```ts
vehicles.add(feature);
vehicles.addMany(features);
vehicles.update("truck-42", nextFeature);
vehicles.remove("truck-42");
vehicles.replace(nextSnapshot);
vehicles.clear();
```

Every stored feature must have a string or number `feature.id`. Static GeoJSON passed directly to `geoJSON()` may remain anonymous, but mutable source features need canonical identity for update and removal.

## Read-only protocol

Renderer consumers do not import or test the `FeatureSource` class. Core exports a generic structural contract:

```ts
interface ReadonlyFeatureSource<TFeature> {
  getSnapshot(): {
    version: number;
    features: readonly TFeature[];
  };

  subscribe(listener: (change: FeatureSourceChange<TFeature>) => void): () => void;
}
```

`geoJSON`, `textLayer` and `ObjectManager` accept any object satisfying this protocol. Standard therefore depends on the Core contract, not on the optional `orihon/source` implementation.

## API

| Member | Behavior |
| --- | --- |
| `featureSource(input?)` / `createFeatureSource(input?)` | Create a source from a Feature, FeatureCollection or iterable of identified Features. |
| `size` / `version` | Current feature count and monotonic mutation version. |
| `get(id)` / `has(id)` | Read or test one feature. |
| `getSnapshot()` | Return `{ version, features }` in insertion order. |
| `getFeatures()` | Convenience alias returning only snapshot features. |
| `toGeoJSON()` | Return a FeatureCollection snapshot. |
| `add(feature)` / `addMany(features)` | Add identified features; duplicate or missing ids throw. One `addMany` call emits one delta. |
| `update(feature)` / `update(id, patch)` | Replace or shallow-patch one existing feature while preserving its id. |
| `remove(idOrIds)` | Remove existing ids; unknown ids are ignored. |
| `replace(features)` | Atomically replace the complete snapshot and emit `reset`. |
| `clear()` | Remove every feature and emit `reset`. |
| `batch(callback)` | Coalesce any nested mutations into one versioned `reset` notification. |
| `subscribe(listener)` | Observe `add`, `update`, `remove` and `reset` deltas; returns an unsubscribe function. |

Treat returned feature objects as immutable snapshots. Apply changes through the source so every renderer receives them.

## Lifecycle and rendering

`GeoJSONLayer` and `TextLayer` subscribe while attached to a map and unsubscribe on `remove()`. Re-adding either layer first refreshes it from the latest source snapshot. `ObjectManager` owns its rendered data independently of map attachment, so it remains subscribed until `destroy()`.

GeoJSON add/update/remove currently rebuilds the affected `GeoJSONLayer` collection. `TextLayer` already recomputes collision layout after data changes. `ObjectManager` applies add/update/remove deltas incrementally. A reset diffs ids against the new snapshot so state for retained objects is preserved.

Selection, hover, alarm and other renderer-specific state do not live in `FeatureSource`. `ObjectManager` keeps that state separately in `ObjectState`; updating domain data therefore does not make one renderer's hover state leak into another renderer.

ObjectManager renders GeoJSON Point, LineString and Polygon geometries. Other valid GeoJSON geometry types remain available to `geoJSON` and `textLayer` but are not rendered by ObjectManager.

A runnable courier-fleet example is available in [`examples/feature-source`](../examples/feature-source/README.md). It demonstrates batch movement, incremental add/remove, full snapshot replacement, and retained ObjectManager selection.

`FeatureSource` deliberately has no map-level name, viewport, spatial query API, paint rules or renderer settings. Those belong to loaders, indexes and layers. This keeps one data model reusable across SVG, canvas, WebGL and ObjectManager without turning Orihon into a style-spec or state-management implementation.
