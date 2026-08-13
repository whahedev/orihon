import { createEl } from "../dom.js";
import { TILE_SIZE } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";

export interface GridLayerOptions extends LayerOptions {
  tileSize?: number;
  opacity?: number;
  zIndex?: number;
  className?: string;
}

export interface ResolvedGridLayerOptions extends LayerOptions {
  pane: string;
  attribution: string;
  tileSize: number;
  opacity: number;
  zIndex: number;
  className: string;
}

export class GridLayer<TOptions extends ResolvedGridLayerOptions = ResolvedGridLayerOptions> extends Layer<TOptions> {
  container: HTMLDivElement | null = null;

  constructor(options: GridLayerOptions = {}) {
    super({
      pane: "tile",
      attribution: "",
      tileSize: TILE_SIZE,
      opacity: 1,
      zIndex: 0,
      className: "oh-grid-layer",
      ...options
    } as TOptions);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.container = createEl("div", this.options.className, pane);
    this.container.style.opacity = String(this.options.opacity);
    this.container.style.zIndex = String(this.options.zIndex);
  }

  override onRemove(): void {
    this.container?.remove();
    this.container = null;
    super.onRemove();
  }

  getTileSize(): number {
    return this.options.tileSize;
  }

  setOpacity(opacity: number): this {
    const next = Number(opacity);
    this.options.opacity = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 1;
    if (this.container) this.container.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndex(zIndex: number): this {
    this.options.zIndex = Number(zIndex);
    if (this.container) this.container.style.zIndex = String(this.options.zIndex);
    return this;
  }

  bringToFront(): this {
    this.#moveToEdge(true);
    return this;
  }

  bringToBack(): this {
    this.#moveToEdge(false);
    return this;
  }

  #moveToEdge(front: boolean): void {
    const container = this.container;
    const parent = container?.parentElement;
    if (!container || !parent) return;
    const siblingZIndexes = Array.from(parent.children, (element) => {
      const value = Number.parseInt(getComputedStyle(element).zIndex, 10);
      return Number.isFinite(value) ? value : 0;
    });
    const edge = front
      ? Math.max(0, ...siblingZIndexes) + 1
      : Math.min(0, ...siblingZIndexes) - 1;
    this.setZIndex(edge);
    if (front) parent.appendChild(container);
    else parent.prepend(container);
  }
}

export function gridLayer(options?: GridLayerOptions): GridLayer {
  return new GridLayer(options);
}
