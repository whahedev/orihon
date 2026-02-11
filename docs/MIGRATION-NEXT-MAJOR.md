# Next-major migration (PR #1)

These changes are intentionally incompatible with the published 1.x API.
Use the local build when testing this branch. No npm release has been published.

## Named coordinates

Map centers, camera methods, markers, vectors, bounds, routing waypoints, point
batches and ObjectManager point inputs now require `{ lat, lng }` or `LatLng`.
Bare `[lat, lng]` arrays are rejected in both TypeScript and JavaScript.

```js
import { marker, fromGeoJSONPosition, toGeoJSONPosition } from "orihon";

marker({ lat: 55.751244, lng: 37.618423 });
marker(fromGeoJSONPosition([37.618423, 55.751244]));
const position = toGeoJSONPosition({ lat: 55.751244, lng: 37.618423 });
// position is [37.618423, 55.751244] in standard GeoJSON order.
```

Replace legacy bounds with two named corners or `{ south, west, north, east }`.
Replace `coordinates: [lat, lng]` in managed points with
`coordinates: { lat, lng }`. GeoJSON `geometry.coordinates` remains
longitude-first; do not rewrite GeoJSON arrays as objects.

`latLng(latitude, longitude)` and `lngLat(longitude, latitude)` remain available.
`LatLng.toArray()` still serializes latitude-first, but its result is deliberately
not accepted as a geographic API input. Prefer `toGeoJSONPosition()` for export.
The GeoJSON converter ignores altitude and validates the first two components.
Named coordinates require finite numbers; numeric strings are not coordinates.

Pixel coordinates, icon anchors and pixel bounds still accept `[x, y]`.
Specialized packed numeric buffers and heat samples retain their documented
layouts; convert explicitly when passing their positions to geographic methods.

## Explicit time units

Public camera and object animation durations now use milliseconds. Renaming a
camera field alone is insufficient: multiply its old seconds value by 1000.

| Previous API | Next-major API | Value conversion |
| --- | --- | --- |
| Camera `duration` | `durationMs` | Seconds × 1000 |
| Map / React `zoomAnimationDuration` | `zoomAnimationDurationMs` | Seconds × 1000; default 250 ms |
| ObjectManager animation `duration` | `durationMs` | Already ms; default 800 ms |
| Symbol motion `duration`, `startTime` | `durationMs`, `startTimeMs` | Already ms; start uses `performance.now()` |
| Path batch `cameraRedrawInterval`, `cameraSettleDelay` | `cameraRedrawIntervalMs`, `cameraSettleDelayMs` | Already ms |
| Trail `maxAge` | `maxAgeMs` | Already ms; default 120000 ms |
| Routing result `duration` | `durationMs` | Provider seconds × 1000 |

```js
map.flyTo({ lat: 55.75, lng: 37.62 }, 12, { durationMs: 1000 });
manager.moveObject("vehicle", { lat: 55.76, lng: 37.63 }, {
  animate: true, durationMs: 0
});
```

Zero animation duration moves immediately, including CPU and GPU object motion.
Zero trail age disables age-based trimming (the point-count cap remains).
Negative, non-finite and string time values are rejected. Removed option names
throw actionable errors instead of silently falling back to defaults.
Convert external routing-provider seconds at the adapter boundary; the navigation
example demonstrates OSRM → `durationMs`. Do not change the external OSRM schema.

## Explicit circle and cluster radii

```js
circle({ lat: 55.75, lng: 37.62 }, { radiusMeters: 500 }); // EPSG:3857
circle({ lat: 200, lng: 300 }, { radiusMapUnits: 50 }); // CRS.Simple
circleMarker({ lat: 55.75, lng: 37.62 }, { radiusPixels: 8 });
```

`Circle` / `circle()` and `setRadius()` now require the exported `CircleRadius`
union: exactly one of `radiusMeters` or `radiusMapUnits`. Numeric radii are
rejected. `getRadius()` returns a copy of that unit-bearing object, not a number;
the old mutable `radiusMeters` field is removed. A mismatched CRS rejects before
attachment or radius mutation. Detached map-unit circles retain correct bounds.

`CircleMarker` replaces `radius` with `radiusPixels`, `getRadius()` with
`getRadiusPixels()`, and `setRadius()` with `setRadiusPixels()`. Its public
`radiusPixels` getter is read-only. Radii must be finite non-negative numbers;
zero is supported. Pixel radii refer to CSS pixels, not device pixels.

Draw circle GeoJSON properties and radius edit events now carry `radiusMeters`
or `radiusMapUnits` instead of `radius`. Migrate saved circle properties explicitly;
the loader does not infer their CRS or units. Zero-radius circles remain circles.

ObjectManager `clusterGridSize` / `setClusterGridSize()` become
`clusterRadiusPixels` / `setClusterRadiusPixels()`. This is still the same
hierarchical greedy pixel-radius algorithm, with default 50 and minimum 20;
there is no value conversion. Removed constructor options are rejected.

Specialized heat bandwidth, style-expression and packed-buffer layouts are not
renamed in this batch; retain their separately documented units.

## Remaining review work

Competing marker/factory modes, remaining asynchronous lifecycle contracts, event
typing, mutable public state and renderer registration remain open and must be
completed before a next-major release.
