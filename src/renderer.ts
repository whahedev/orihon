import { createEl } from "./dom.js";
import { InteractiveLayer } from "./interactive-layer.js";
import { type LayerOptions } from "./layer.js";
import type { Orihon } from "./map.js";

export interface RendererOptions extends LayerOptions {
  className?: string;
}

export class Renderer<TOptions extends RendererOptions = RendererOptions, TEvents extends object = {}> extends InteractiveLayer<TOptions, TEvents> {
  container: HTMLElement | SVGElement | null = null;

  constructor(options = {} as TOptions) {
    super({ pane: "overlay", ...options } as TOptions);
  }

  protected createContainer(): HTMLElement | SVGElement {
    return createEl("div", this.options.className ?? "oh-renderer");
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane ?? "overlay"}`);
    this.container = this.createContainer();
    pane.appendChild(this.container);
  }

  override onRemove(): void {
    this.container?.remove();
    this.container = null;
    super.onRemove();
  }

  getContainer(): HTMLElement | SVGElement | null {
    return this.container;
  }
}
