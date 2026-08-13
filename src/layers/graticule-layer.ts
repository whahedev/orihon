import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface GraticuleLayerOptions extends LayerOptions {
  step?: number | "auto";
  units?: "degrees" | "map";
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  maxLines?: number;
}

export class GraticuleLayer extends Layer<Required<GraticuleLayerOptions>> {
  svg: SVGSVGElement | null = null;
  path: SVGPathElement | null = null;
  private readonly update = (): void => this.render();

  constructor(options: GraticuleLayerOptions = {}) {
    super({
      pane: "overlay",
      attribution: "",
      step: "auto",
      units: "degrees",
      stroke: "#64748b",
      strokeWidth: 1,
      strokeOpacity: 0.55,
      maxLines: 80,
      ...options
    } as Required<GraticuleLayerOptions>);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("oh-graticule-layer");
    this.svg.style.position = "absolute";
    this.svg.style.inset = "0";
    this.svg.style.pointerEvents = "none";
    this.path = document.createElementNS(SVG_NS, "path");
    this.path.setAttribute("fill", "none");
    this.svg.appendChild(this.path);
    pane.appendChild(this.svg);
    map.on("move", this.update);
    map.on("zoom", this.update);
    map.on("resize", this.update);
    this.render();
  }

  override onRemove(): void {
    this.map?.off("move", this.update);
    this.map?.off("zoom", this.update);
    this.map?.off("resize", this.update);
    this.svg?.remove();
    this.svg = null;
    this.path = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.svg || !this.path) return;
    const incompatible = this.map.crs.code === "Simple" && this.options.units !== "map";
    this.svg.style.display = incompatible ? "none" : "";
    if (incompatible) return;
    const { width, height } = this.map.size;
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.path.setAttribute("stroke", this.options.stroke);
    this.path.setAttribute("stroke-width", String(this.options.strokeWidth));
    this.path.setAttribute("stroke-opacity", String(this.options.strokeOpacity));
    const bounds = this.map.getBounds();
    const xSpan = Math.abs(bounds.east - bounds.west);
    const ySpan = Math.abs(bounds.north - bounds.south);
    const step = typeof this.options.step === "number"
      ? Math.max(Number.EPSILON, Math.abs(this.options.step))
      : niceStep(Math.max(xSpan, ySpan) / 7, this.options.units === "degrees" ? 90 : Infinity);
    const lines: string[] = [];
    const maxLines = Math.max(2, this.options.maxLines);
    let count = 0;
    for (let x = Math.ceil(bounds.west / step) * step; x <= bounds.east && count < maxLines; x += step, count++) {
      const a = this.map.latLngToLayerPoint([bounds.south, x]);
      const b = this.map.latLngToLayerPoint([bounds.north, x]);
      lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
    }
    for (let y = Math.ceil(bounds.south / step) * step; y <= bounds.north && count < maxLines; y += step, count++) {
      const a = this.map.latLngToLayerPoint([y, bounds.west]);
      const b = this.map.latLngToLayerPoint([y, bounds.east]);
      lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
    }
    this.path.setAttribute("d", lines.join(""));
  }
}

function niceStep(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  return Math.min(max, (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power);
}

export function graticuleLayer(options?: GraticuleLayerOptions): GraticuleLayer {
  return new GraticuleLayer(options);
}
