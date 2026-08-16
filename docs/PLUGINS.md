# Plugin Development

A plugin should extend a documented Orihon class or return a regular `Layer`/`Control`. Do not patch prototypes or import files below `Orihon/dist`.

## Rules

- Declare `Orihon` as a peer dependency and test against the lowest and newest supported 1.x versions.
- Import from `Orihon`, `Orihon/core` or `Orihon/standard` only.
- Allocate DOM or browser resources in `onAdd` and release all of them in `onRemove`.
- Keep network providers injectable and accept `AbortSignal` for cancellable work.
- Put plugin rendering in a named pane and expose attribution when a data source requires it.
- Export TypeScript types and avoid global side effects.

## Layer Skeleton

```ts
import { Layer, type Orihon } from "orihon/core";

export class StatusLayer extends Layer {
  private element: HTMLDivElement | null = null;

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.element = document.createElement("div");
    this.element.className = "my-status-layer";
    map.getPane("overlay")?.append(this.element);
  }

  override onRemove(): void {
    this.element?.remove();
    this.element = null;
    super.onRemove();
  }
}
```

Keep the plugin as its own package with `Orihon` as a peer dependency, package exports, strict TypeScript and add/remove lifecycle tests.

## First-party optional entries

| Name | Entry | Budget | Peer dependencies |
| --- | --- | --- | --- |
| Draw | `orihon/draw` + `orihon/draw.css` | ≤ 12 KiB gzip | `orihon` |
| React | `orihon/react` | application-bundled | `react >= 18`, `react-dom >= 18`, `orihon` |
| PMTiles | `orihon/pmtiles` | optional entry | `orihon` |
| MLT | `orihon/mlt` | optional entry | `orihon` |
| MVT WASM | `orihon/mvt-wasm` | optional entry | `orihon` |
| WebGPU tiles | `orihon/webgpu` | optional entry | `orihon` |
| Controls | `orihon/controls` | ≤ 8 KiB gzip | `orihon` |
| Geo | `orihon/geo` | ≤ 2 KiB gzip | none |

The PMTiles entry contains a minimal v3 range reader, MVT provider and raster blob source without a runtime dependency on the full `pmtiles` package. Advanced `orihon` already sniffs Orihon MLT and uses WASM MVT geometry plus WebGPU raster tiles through `createMVTProvider` / `decodePackedMVT` / `tileLayer({ renderer: "auto" })`. The optional entries remain for the MLT encoder (`encodePackedMLT`) and for Standard-only apps that import `orihon/mvt-wasm` or `orihon/webgpu` without the Advanced bundle.

This table is the first-party registry. Third-party plugins should publish their import entry, measured gzip size, Orihon peer range, lifecycle guarantees and data-provider attribution in the same form.
