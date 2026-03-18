# FeatureSource

`orihon/source` is a small renderer-independent container for GeoJSON Features. Canonical GeoJSON `feature.id` values provide identity, while versioned snapshots and delta events notify any number of consumers without introducing a MapLibre-style map source registry.

```ts
import { featureSource } from "orihon/source";
import { geoJSON, textLayer } from "orihon/standard";
import { objectManager } from "orihon";

const vehicles = featureSource(featureCollection);

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

Every stored feature must have a string or number `feature.id`. The `orihon/source` types
use `IdentifiedGeoJSONFeature` so TypeScript rejects anonymous features at the source
boundary. Static GeoJSON passed directly to `geoJSON()` may remain anonymous, but mutable
source features need canonical identity for update and removal.

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

`getSnapshot()` caches the feature array for the current `version`. Repeated calls return the same object until the next mutation.

## API

| Member | Behavior |
| --- | --- |
| `featureSource(input?)` / `new FeatureSource(input?)` | Create a source from a Feature, FeatureCollection or iterable of identified Features. |
| `size` / `version` | Current feature count and monotonic mutation version. |
| `get(id)` / `has(id)` | Read or test one feature. |
| `getSnapshot()` | Return `{ version, features }` for the current version (cached until the next mutation). |
| `getFeatures()` | Convenience alias returning only snapshot features. |
| `toGeoJSON()` | Return a FeatureCollection snapshot. |
| `add(feature)` / `addMany(features)` | Add identified features; duplicate or missing ids throw. One `addMany` call emits one delta. |
| `update(feature)` / `update(id, patch)` | Always shallow-merge into the existing feature (optional fields not present in the patch are kept). |
| `remove(idOrIds)` | Remove existing ids; unknown ids are ignored. |
| `replace(features)` | Atomically replace the complete snapshot and emit `reset`. |
| `clear()` | Remove every feature and emit `reset`. |
| `batch(callback)` | Run **synchronous** nested mutations as one versioned `batch` delta (coalesced add/update/remove). `replace`/`clear` inside the callback still emit `reset`. Async callbacks throw. |
| `subscribe(listener)` | Observe `add`, `update`, `remove`, `batch` and `reset` deltas; returns an unsubscribe function. |

Treat returned feature objects as immutable snapshots. Apply changes through the source so every renderer receives them.

## Change payloads

```ts
type FeatureSourceChange<T> =
  | { type: "add" | "update"; features: readonly T[]; version: number }
  | { type: "remove"; ids: readonly FeatureId[]; version: number }
  | { type: "batch"; version: number; changes: readonly FeatureSourceDelta<T>[] }
  | { type: "reset"; version: number };
```

A `batch` groups coalesced deltas for one version bump, for example:

```ts
source.batch(() => {
  source.update("a", a);
  source.update("b", b);
  source.remove("c");
});
// → { type: "batch", version, changes: [
//      { type: "update", features: [a, b] },
//      { type: "remove", ids: ["c"] }
//    ] }
```

## Lifecycle and rendering

`GeoJSONLayer` and `TextLayer` subscribe while attached to a map and unsubscribe on `remove()`. Re-adding either layer first refreshes it from the latest source snapshot. `ObjectManager` owns its rendered data independently of map attachment, so it remains subscribed until `destroy()`.

`GeoJSONLayer` applies `add` / `update` / `remove` / `batch` incrementally for SVG feature layers (id-indexed). Canvas/WebGL path batches and `reset` still rebuild from the snapshot. `TextLayer` refreshes from the snapshot because collision layout is already O(n). `ObjectManager` applies add/update/remove/batch deltas incrementally; a reset diffs ids against the new snapshot so state for retained objects is preserved.

Selection, hover, alarm and other renderer-specific state do not live in `FeatureSource`. `ObjectManager` keeps that state separately in `ObjectState`; updating domain data therefore does not make one renderer's hover state leak into another renderer.

ObjectManager renders GeoJSON Point, LineString and Polygon geometries. Other valid GeoJSON geometry types remain available to `geoJSON` and `textLayer` but are not rendered by ObjectManager.

A runnable courier-fleet example is available in [`examples/feature-source`](../examples/feature-source/README.md). It demonstrates batch movement, incremental add/remove, full snapshot replacement, and retained ObjectManager selection.

`FeatureSource` deliberately has no map-level name, viewport, spatial query API, paint rules or renderer settings. Those belong to loaders, indexes and layers. This keeps one data model reusable across SVG, canvas, WebGL and ObjectManager without turning Orihon into a style-spec or state-management implementation.
