# Security model

Orihon treats untrusted content and network side effects as first-class risks. The default path is safe: strings become text, HTML is opt-in through explicit DOM nodes, SVG strings are scrubbed before insertion, and offline helpers refuse to cache the open web.

This page is the contract. Feature docs describe *how* to use an API; this page describes *what will not happen* unless the application opts in.

## Principles

1. **Strings are text, not markup.** Popup, tooltip, marker, DivIcon and custom-control string content is applied with `textContent`.
2. **Markup requires ownership.** Pass a `Node` (or mount into a container you control) when you need HTML structure.
3. **Lifecycle cleanup is explicit.** Mountable popup content can register disposal; Orihon runs it on close, replace and destroy.
4. **Offline caching is allowlisted.** Service Worker network caching only writes responses under configured `urlPrefixes`, never opaque arbitrary GETs.
5. **Prefetch is bounded.** Tile prefetch requires geographic or tile ranges and enforces `maxTiles`.
6. **Providers stay in the app.** Search, routing, traffic and remote object loaders do not embed third-party credentials or endpoints inside Orihon.

## Overlay content (popups and tooltips)

`bindPopup` / `bindTooltip` accept:

| Input | Behavior |
| --- | --- |
| `string` / `number` | Rendered as plain text via `textContent` |
| `Node` | Inserted as application-owned DOM |
| `(context) => content` | Sync or async factory; result follows the rules above |
| `{ mount, unmount? }` | Mountable object; `mount` may return a cleanup function or `{ destroy() }` |

Cleanup runs when content is replaced, the overlay closes, or the layer is destroyed. Rejected async factories emit `contenterror`. Stale async results (after a newer generation) are ignored so late network responses cannot overwrite newer UI.

```js
// Safe by default — treated as text, not HTML
marker(position).bindPopup("<img src=x onerror=alert(1)>");

// Explicit markup — application owns the node
const card = document.createElement("div");
card.append(titleNode, bodyNode);
marker(position).bindPopup(card);

// Mountable UI with disposal
marker(position).bindPopup({
  mount(container, context) {
    const root = createApp(container, context);
    return () => root.destroy();
  }
});
```

## Markers and DivIcon

- Marker title / fallback label strings use `textContent`.
- `divIcon({ content })` string content is plain text. Pass a `Node` when the icon must contain structured markup.

## SVG overlays

When `svgOverlay` receives an SVG **string**, Orihon parses it and runs `sanitizeSvgElement` before DOM insertion:

- Removes dangerous tags: `script`, `foreignObject`, `iframe`, `object`, `embed`
- Strips event-handler attributes (`onclick`, …)
- Strips `javascript:`, `data:` and `vbscript:` URLs from attributes

Prefer passing a trusted `SVGElement` you built yourself when the SVG is application-authored.

## Custom controls

`customControl` content may be text, a `Node`, or `(map) => text | Node`. Strings again use `textContent`. There is no `innerHTML` path in the control renderer.

## Offline cache and Service Worker

`offlineTileCache` helpers are conservative by design:

- **`urlPrefixes`** — without prefixes, the generated Service Worker may *serve* existing cache hits but will **not** network-cache new arbitrary GETs.
- With prefixes, only URLs that start with an allowlisted prefix are eligible for network→cache writes.
- Opaque responses are never written into the cache from the Service Worker network path.
- **`prefetchTileLayer`** requires `bounds` or explicit tile ranges and throws if the request would exceed `maxTiles`.

```js
const cache = offlineTileCache({ cacheName: "city-tiles" });

await cache.registerServiceWorker({
  urlPrefixes: ["https://tile.openstreetmap.org/"]
});

await cache.prefetchTileLayer(streets, {
  bounds: map.getBounds(),
  zooms: [10, 11, 12],
  maxTiles: 2048
});
```

## Remote data and providers

Advanced networking APIs (`RemoteObjectManager`, search, routing, traffic, MVT providers) take **application-supplied** loaders and endpoints. Orihon orchestrates cancellation, viewport bounds and display; it does not ship vendor API keys or default cloud backends.

`RemoteObjectManager` aborts stale viewport requests when the view moves, so abandoned fetches do not apply late results.

## What this is not

- Orihon is not a sandbox for hostile iframes or untrusted script execution inside mountable content you choose to run.
- Passing a malicious `Node` or executing untrusted code inside `mount` is still application responsibility.
- Tile URLs and provider endpoints you configure are trusted at the network policy layer of *your* app (CSP, CORS, allowlists).

The goal is a secure **default API surface**: HTML-string map UIs should not silently reopen XSS and cache-poisoning footguns.

## Related

- [API reference](API.md) — popup content types and overlay lifecycle
- [Plugin development](PLUGINS.md) — stay on public entries; do not patch prototypes
