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
