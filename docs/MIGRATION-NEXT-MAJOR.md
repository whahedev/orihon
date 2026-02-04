# Next-major migration (PR #1)

These changes are intentionally incompatible with the published 1.x coordinate API.
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

## Remaining review work

This migration does not yet change time/radius units, competing marker/factory
modes, event typing, mutable public state or renderer registration. Those review
items remain open and must be completed before a next-major release.
