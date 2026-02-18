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

## Suggest and routing cancellation

`SuggestProvider.suggest()` and `RoutingLayer.route()` now reject with an error
named `AbortError` when cancelled, superseded by a newer request, or aborted by
`context.signal`. They no longer resolve `[]` to disguise cancellation. Already
aborted signals reject without invoking the provider, even for short/empty input.
Cancellation settles promptly even if a custom provider ignores its signal;
late responses cannot replace current results. Providers should still pass the
received signal to `fetch()` to stop their own network work.

```js
try {
  const routes = await routing.route(waypoints, { signal: controller.signal });
  renderRoutes(routes); // [] here means a successful empty result.
} catch (error) {
  if (error?.name !== "AbortError") throw error;
  // Cancelled/superseded: leave results belonging to the latest request alone.
}
```

Both services remain reusable after `cancel()`. Routing removal also cancels
pending work (including map-driven removal); the last successful route data is
retained for reattachment. `SuggestProvider.destroy()` remains terminal and
idempotent. Successful `null`/`undefined` provider results still normalize to `[]`.
Other provider errors propagate unchanged, preserving the original error/cause.

`RoutingLayer` emits one `abort` event for a cancelled request, not `load` or
`error`; its event includes the error and waypoints. `SuggestWidget` consumes
rejections internally: a current-request cancellation emits `abort`, while
superseded/destroyed widget requests stay silent. A widget does not destroy its
caller-owned provider. Private pending-request fields are no longer public API.

## Remote viewport loading

`RemoteObjectManager.reload({ signal }?)` now returns `Promise<ManagedObject[]>`,
not the manager. It starts immediately; `debounceMs` only affects automatic
add/move/zoom/resize loads. Replace chained or fire-and-forget `reload()` calls
with awaited calls or explicit rejection handling:

```js
try {
  const objects = await remote.reload({ signal: controller.signal });
  console.log(`Loaded ${objects.length} objects`);
} catch (error) {
  if (error?.name !== "AbortError") throw error;
}
```

Cancel, supersession, detach, map destruction and manager destruction reject
unfinished explicit reloads with `AbortError`, even when the loader ignores its
signal. Viewport changes invalidate old responses immediately, before debounce.
Loader failures reject unchanged. Automatic requests have no caller-owned Promise;
subscribe to `load`, `error` and `abort` for their outcomes. No stale request may
clear the loading state of a newer one. Pending debounce alone is not `loading`.

`remove()` cancels and detaches while retaining data; reattachment remains valid.
`destroy()` is idempotent and prohibits future remote reloads and attachment with
`AbortError`. Calling `reload()` while detached rejects with an actionable error.
Map `destroy()` now emits `unload` once, allowing the remote manager to detach and
cancel automatically; the manager can subsequently attach to another live map.
After manager destruction, late lifecycle events are suppressed.

Successful null/undefined loader results still normalize to `[]`. Cancellation
and provider failure retain stored data. Invalid response shapes and legacy
coordinate tuples are checked before clearing the store. This does not make all
inherited ObjectManager mutations transactional or terminal; that broader store
lifecycle remains a separate review item. Remote timer/controller bookkeeping is
now private. `debounceMs` rejects negative, non-finite and string values.

## Remaining review work

Competing marker/factory modes, base ObjectManager store lifecycle and detach/delete
overloads, event typing, mutable public state and renderer registration
remain open and must be completed before a next-major release.
