# Troubleshooting

Short answers to the failures that look like a broken library but are almost always a page-level
detail. Each section is linked from the message Orihon prints, so the console tells you which one
you are in.

## Zero-size container

> Orihon: map container has zero height, so nothing will be visible.

A map fills its container. If the container has no height, tiles are still requested and layers
still exist, but nothing is painted — the page looks like the library silently failed.

A `<div>` has no intrinsic height, so this is the default state unless you give it one:

```html
<div id="map"></div>
```

```css
#map { height: 400px; }
```

Any of these work as well: a fixed `height`, `height: 100%` when *every* ancestor up to `<html>`
also has a height, a flex or grid child with `min-height: 0` plus a track that has a size, or
`position: absolute` with `top`/`bottom` set. What does not work is `height: 100%` inside an
ancestor whose own height is `auto` — percentages resolve against a parent with no height, which
is zero.

The warning is printed once per map, a frame after setup, and only when the container is in the
document and not `display: none`. So it does not fire for the ordinary "create the map, then
append the container" order, nor for a map inside a tab that is currently hidden.

If the container gets its size later — a panel that opens, a tab that becomes visible — the map
picks it up on its own through `ResizeObserver`. Call `map.invalidateSize()` yourself only in the
environments where that observer is unavailable.

## The map is visible but tiles never appear

Check the network panel first: a tile URL is an ordinary HTTP request.

- The template must contain `{z}`, `{x}` and `{y}`. `tileLayer()` does not guess.
- Cross-origin tile servers must send permissive CORS headers when you export or read pixels
  (`exportPng`, WebGL tile rendering). Plain DOM tiles do not need them.
- A tile provider that requires an API key rejects unauthenticated requests, usually with 401 or
  403 rather than an error the layer can explain.

`tileLayer(url).getStats()` reports how many tiles are active, retained, cached and in flight,
which separates "never requested" from "requested and failed".

## `UnsupportedCapabilityError` from `tileLayer(url, { renderer })`

`"webgl"` and `"webgpu"` are explicit requests: if the context is unavailable, or the entry that
registers GPU tiles was never imported, the call throws instead of quietly drawing DOM tiles. The
error's `context` says which of the two it was — `reason: "unsupported"` or `"unregistered"`.

Use `renderer: "auto"` when a silent fallback is what you want, and the default `"dom"` when it
is not a decision worth making.

## `DestroyedError` versus `AbortError`

They mean different things and are worth handling differently:

- `AbortError` — the operation you started was cancelled, usually because a newer one replaced it.
  Normal in a search box or a viewport-driven loader; ignore it.
- `DestroyedError` — the resource itself is gone, and every later call on it will fail the same
  way. A sign that something outlived the map or widget that owned it.
