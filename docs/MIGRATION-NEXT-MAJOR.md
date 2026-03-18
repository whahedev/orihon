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
the old mutable `radiusMeters` field is removed. Prefer the unit-named methods
`getRadiusMeters()` / `setRadiusMeters()` and `getRadiusMapUnits()` /
`setRadiusMapUnits()`; asking for the inactive unit throws. A mismatched CRS
rejects before attachment or radius mutation. Detached map-unit circles retain
correct bounds.

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

`detach()` cancels and detaches while retaining data; reattachment remains valid.
`destroy()` is idempotent and prohibits future remote reloads and attachment with
`AbortError`. Calling `reload()` while detached rejects with an actionable error.
Map `destroy()` now emits `unload` once, allowing the remote manager to detach and
cancel automatically; the manager can subsequently attach to another live map.
After manager destruction, late lifecycle events are suppressed.

Successful null/undefined loader results still normalize to `[]`. Cancellation
and provider failure retain stored data. Invalid response shapes and legacy
coordinate tuples are checked before clearing the store. This does not make all
inherited ObjectManager mutations transactional; terminal state is covered below.
Remote timer/controller bookkeeping is
now private. `debounceMs` rejects negative, non-finite and string values.

## ObjectManager lifetime and data removal

The ambiguous `ObjectManager.remove()` overload (including RemoteObjectManager) is
removed. Use `detach()` to disconnect from a map, `removeObjects(idOrIds)` to delete
records, `clear()` to discard all records, and `destroy()` for final cleanup.

```js
manager.removeObjects(["truck-1", "truck-2"]); // Remains on the map.
manager.detach(); // Keeps records and source subscription; may be added again.
manager.addTo(otherMap);
manager.destroy(); // Releases source/scene/imports; cannot be revived.
```

`isDestroyed` is a read-only boolean. After destruction, imports, attachment,
layout preparation and data/state/style mutations throw or reject with `AbortError`.
Reads remain available; cleanup calls such as `clear()`, `detach()`, `closePopup()`,
`endBulk()` and repeated `destroy()` remain safe. Late scheduled renders are no-ops.
Raw public stores/options still need encapsulation in a later review batch; do not
mutate them to bypass the supported methods.

Pending `addAsync()` calls reject promptly on destroy, including when `next()` is
blocked. Iterator `return()` is requested but cannot force external code to stop;
late yielded values are never ingested. External AbortSignal cancellation retains
the accepted prefix and ends bulk mode; destroy clears the data. Detachment alone
does not cancel logical imports. Map `unload` detaches both local and remote managers.

React now creates managers in the effect and destroys them during its cleanup,
including development Strict Mode replay. `onReady` may receive a new instance after
replay; do not reuse an earlier destroyed instance. The current instance receives
the objects again, and source subscriptions are released at unmount.

## Draw lifetime and feature ownership

`DrawHandler` and `DrawControl` now distinguish reusable `remove()` from final
`destroy()`. The latter is idempotent and exposes read-only `isDestroyed`.
`remove({ destroyFeatures: true })` is removed and rejected at runtime; choose
explicitly whether to discard caller-owned data:

```js
draw.remove(); // Cancel draft, release input/edit listeners; retain data/history.
draw.addTo(otherMap); // Reusable, initially in "off" mode.
draw.destroy(); // Final cleanup; this instance cannot be attached again.

// When a featureGroup was supplied by the application:
sharedGroup.clearLayers(); // Explicit application decision, not done by destroy().
```

Destroy clears a group created internally by Draw, but preserves a supplied
group's features and unrelated subscriptions. Remove/destroy detach the group
only if Draw attached it; an already attached caller-owned group stays on its map.
A supplied group attached to a different map must be removed there explicitly
before transferring Draw. Standalone handlers now detach on map `unload` too;
map destruction does not destroy the Draw instance or erase its features.

After destruction, `addTo()`, `setMode()`, `finish()`, `undo()`, `redo()`, `loadData()`
and control `setPosition()` throw `AbortError`. Reads, `cancel()`, `remove()` and
repeated `destroy()` stay safe. `DrawHandler.map` and `.mode` are read-only;
use the lifecycle methods and `setMode()` instead of assigning fields directly.

Removal restores captured map behaviors, releases edit-handle and keyboard
listeners, and keeps undo/redo history across reattachment. Destruction releases
history and Draw event subscriptions. Cancellation from within `drawstart` cannot
commit a late feature, and browser `pointercancel` now discards the draft rather
than treating it as pointer-up. Toolbar transfers remove the previous DOM/control
registration; failed control attachment rolls back the new registration.

## Layer options are read-only

`layer.options` is a `Readonly` configuration snapshot. Direct field writes do not
update rendering and are rejected by TypeScript:

```js
// Before (compiled, but did not refresh DOM)
marker.options.opacity = 0.5;

// After
marker.setOpacity(0.5);
path.setStyle({ stroke: "#2563eb" });
```

## Layer iteration

`eachLayer(callback, context)` no longer accepts a second `thisArg`. Use an arrow
function or `for…of`:

```js
// Before
map.eachLayer(function (layer) { this.handle(layer); }, this);

// After
for (const layer of map.layers) this.handle(layer);
// or
map.eachLayer((layer) => this.handle(layer));
```

`map.layers` is a `ReadonlySet`. `layers.clear()` / `layers.add()` no longer type-check;
mutate through `addLayer` / `removeLayer`.

## FeatureSource batch deltas

`FeatureSource.batch()` no longer collapses every transaction to `reset`. Nested
`add` / `update` / `remove` coalesce into one `{ type: "batch", changes }` event.
`replace()` and `clear()` (including inside `batch`) still emit `reset`.
`getSnapshot()` returns a cached object for the current version. Async `batch`
callbacks throw `TypeError`. `update()` always shallow-merges.

Custom `ReadonlyFeatureSource` consumers must handle `type: "batch"` (or treat
unknown types as a full snapshot refresh).

## Easy object-first commands

Easy `addX` methods are object-first only:

```js
// Before
map.addMarker(position, { popup: "Москва", color: "#2563eb" });
map.addPolyline(route, { stroke: "#2563eb" });
map.addPolygon(area, { fill: "#2563eb" });
map.addTileLayer(url, { opacity: 0.8 });
map.addGeoJSON(data, { style });

// After
map.addMarker({
  position,
  appearance: { color: "#2563eb" },
  popup: "Москва"
});
map.addPolyline({ points: route, style: { stroke: "#2563eb" } });
map.addPolygon({ rings: area, style: { fill: "#2563eb" } });
map.addTileLayer({ url, opacity: 0.8 });
map.addGeoJSON({ data, style });
```

Built-in marker glyph fields belong under `appearance`, not at the top level.

## Easy map-centric dialect

Easy no longer offers a declarative `map.add({ type, ... })` DSL or a
`map.add(layer)` overload. Prefer one subject per API level:

```js
// Easy — map is the subject
map.addMarker({ position: { lat: 55.75, lng: 37.62 }, appearance: { color: "#2563eb" }, popup: "Москва" });
map.addPolyline({ points: route, style: { stroke: "#2563eb" } });

// Standard — layer is the subject
marker({ lat: 55.75, lng: 37.62 }).addTo(map);
```

```js
// Before
map.add({ type: "marker", position, popup: "Москва" });
map.add({ type: "polyline", coordinates: route, style });
map.add({ type: "geojson", data });
map.add({ type: "raster", url });

// After
map.addMarker({ position, appearance: { color: "#2563eb" }, popup: "Москва" });
map.addPolyline({ points: route, style });
map.addGeoJSON({ data });
map.addTileLayer({ url });
```

Attach a ready layer with `layer.addTo(map)` or `map.addLayer(layer)` when mixing
with the Layer API. Description types (`EasyAddDescription`,
`EasyMarkerDescription`, …) are removed.

## Exclusive marker and factory modes

Marker visuals now have three mutually exclusive forms:

```js
marker(position, { shape: "circle", color: "#0f766e", size: 18 });
marker(position, { content: "A", anchor: [0, 0] });
marker(position, { icon: icon({ iconUrl: "pin.png", iconAnchor: [12, 36] }) });
```

Do not combine `content` / `icon` with each other or with built-in appearance
fields (`shape`, `color`, `strokeColor`, `size`, `strokeWidth`). The default with no
visual selector remains a pin. Put an image icon's anchor on `iconAnchor`, not the
ignored marker `anchor`. `html` is removed: rename it to `content`; strings remain
plain text, not parsed HTML. `content: ""` now means an empty marker, not a pin.
`0` is also valid content. Omit inactive fields instead of using null selectors.

Use `setContent(value)`, `setIcon(icon)` or `setAppearance(appearance)` to switch
the existing marker explicitly. `setAppearance()` now selects the built-in glyph
instead of silently updating it behind custom content. `setIcon(null)` returns to
the stored glyph appearance without resurrecting old content. `getContent()` is
null outside content mode. Mode switches reset the previous marker anchor; an
explicit glyph anchor is preserved through same-mode appearance updates/rendering.

`MarkerOptions`, React `MarkerProps` and Easy marker options are now unions. If an
application previously used `interface Custom extends MarkerOptions`, replace it
with `type Custom = MarkerOptions & { ... }`. The exclusivity also applies to
pre-existing variables, not only inline object literals. Invalid combinations
throw `TypeError` before attachment, source subscription or collection iteration.
Direct writes to resolved `.options` remain unsupported; use the setters.

The `icon()` factory (and direct Icon/DivIcon constructors) rejects simultaneous
`iconUrl` and `content`; image-only fields cannot be passed to DivIcon. Image URLs
must be non-empty strings. `icon()` without arguments still creates an empty
DivIcon. Empty content strings and numbers are not treated as absent.

`objectManager()` selects local options, `{ loader }`, or `{ points }`. Loader,
points and reactive source cannot compete for the same collection. An explicitly
present invalid loader/points field, including undefined, is rejected rather than
falling back to local mode. `debounceMs` / `replace` require a loader; point mode
rejects `clusterize`, `clusterRenderer` and `style` (use its `renderer` and marker
options instead). Direct RemoteObjectManager construction also rejects a source
or points. `LocalObjectManagerOptions` and the updated unified union expose the
factory constraints while overloads retain their precise result classes.

## Flat event objects

Event payloads are no longer mirrored under `event.detail`. Use the flat fields:

```ts
// Before
map.on("click", (event) => {
  console.log(event.detail.latlng, event.latlng);
});

// After
map.on("click", (event) => {
  console.log(event.latlng);
});
```

## Typed event subscriptions

`on()`, `once()` and `off()` infer payloads from literal event names. Map, Marker,
base layer attachment events, Draw, ObjectManager, RemoteObjectManager, routing,
SuggestWidget and PerformanceInspector now export event maps. React `useMapEvent()`
and Map `onClick` use the map's event contract too. SuggestWidget preserves its
result-item type in `select` and `results`.

The declarations use TypeScript's built-in `NoInfer`; consumers need TypeScript
5.4 or newer.

```ts
import type { EventFor, EventHandler, MapEventMap, Orihon } from "orihon";

map.on("click", (event) => {
  console.log(event.latlng.lat, event.containerPoint.x);
});
const onZoom: EventHandler<EventFor<MapEventMap, "zoom", Orihon>> = (event) => {
  console.log(event.zoom.toFixed(1));
};
map.on("zoom", onZoom);
map.off("zoom", onZoom);
```

Remove old `on<MyEvent>(...)` / `once<MyEvent>(...)` / `off<MyEvent>(...)`
payload assertions: their type parameter is now the event name. Incompatible
callback annotations no longer override a known event's shape. For your own
emitter, declare its payload map instead:

```ts
import { Evented } from "orihon";
interface PluginEvents { ready: { count: number }; }
class Plugin extends Evented<PluginEvents> {}
new Plugin().on("ready", (event) => console.log(event.count.toFixed()));

// Plugins can add names to an existing public event map.
declare module "orihon" {
  interface MapEventMap { "plugin:ready": { count: number }; }
}
map.on("plugin:ready", (event) => console.log(event.count));
```

Payload fields live only on the flat event object (`event.latlng`, not
`event.detail.latlng`). `target` is the current receiving emitter; `sourceTarget`
may be a propagated child and must be narrowed before using a concrete layer API.
DrawControl delegates subscriptions to its DrawHandler, so its events' `target`
is the handler, not the control. Remote `error` is a union: request failures carry
`context`, while layout failures carry `phase: "layout"`. Provider errors remain
`unknown`, not necessarily Error. Marker drag events do not promise an
`originalEvent`; manager hover-out positions can be null or absent.

Dynamic strings, unregistered names and extra payload fields retain `unknown`,
not `any`. Event-name unions support narrowing via `event.type`. This is a
subscription typing change, not runtime payload validation: low-level `emit()`
and event-parent wiring remain permissive. Plugin authors must emit compatible
payloads and avoid propagating conflicting event names. `off()` clears all
listeners; use `off(type)` for just one name.

### Layer and overlay event payloads

Named events are also typed for SVG paths (Polyline, Polygon, Circle and
CircleMarker), raster/vector tiles, TrafficLayer, TextLayer, HeatLayer, WebGL
points/symbols and image/video/SVG overlays. Popup and Tooltip expose typed
`open`, `close` and `contenterror`; the map exposes `popupopen`, `popupclose`,
`tooltipopen` and `tooltipclose`. Common base events are inherited by concrete
classes. Renderer, SvgLayer, GridLayer, TileLayer and DivOverlay accept a trailing
event-map type parameter for custom subclass events.

- Raster `tileloadstart`, `tileload`, `tileerror` and `tileabort` expose `x`, `y`,
  `z` and `url`. Treat `tile` as optional: the unified factory may choose a GPU
  backend with no HTMLImageElement. Raster `tileerror` does not supply an Error.
  The aggregate `load` event belongs to the DOM tile implementation.
- Vector tiles instead provide `coordinates` (including the provider signal),
  `features` on success and an `unknown` error on failure.
- Heat and WebGL point events contain plain `{ x, y }` screen coordinates, not
  Point class instances. WebGL point/symbol positions are named coordinate
  objects, not LatLng class instances. Do not call class methods on them.
- Heat hover-out can contain null position/feature; `mouseout` still carries
  the previous feature. Packed WebGL points have no original per-point `data`
  object, even when a click hits a valid index. Hover can also have null data.
- Popup/Tooltip `close.map` can be null when `onRemove()` is called while
  detached. Content factories may throw any value; narrow `contenterror.error`
  before accessing Error properties. Image errors include `url`; video errors
  only include the original DOM event.

FeatureGroup and GeoJSON may contain custom child layers (`pointToLayer` included),
so their propagated payloads remain `unknown` by default. For a group with a
controlled set of children, use `new FeatureGroup<MyEvents>()` to declare its map.
Layers without their own events retain typed base add/remove events and the
custom-name fallback; no synthetic load/click events have been added.

## Remaining review work

Renderer registration / import-order capability coupling, ObjectManager identity
(`create` / strict `update` / `upsert`), and broader I/O error hierarchy remain open
and must be completed before a next-major release. `tileLayer()` now returns the
shared `RasterTileLayer` contract; explicit backend failures still fall back to DOM
for `"auto"` / unavailable GPU.
