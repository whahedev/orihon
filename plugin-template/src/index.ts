import { Layer, type Orihon, type LayerOptions } from "orihon/core";

export interface ExampleLayerOptions extends LayerOptions {
  label?: string;
}

export class ExampleLayer extends Layer<ExampleLayerOptions> {
  private element: HTMLDivElement | null = null;

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.element = document.createElement("div");
    this.element.className = "orihon-example-plugin";
    this.element.textContent = this.options.label ?? "Plugin layer";
    map.getPane(this.options.pane ?? "overlay")?.append(this.element);
  }

  override onRemove(): void {
    this.element?.remove();
    this.element = null;
    super.onRemove();
  }
}

export function exampleLayer(options: ExampleLayerOptions = {}): ExampleLayer {
  return new ExampleLayer(options);
}
