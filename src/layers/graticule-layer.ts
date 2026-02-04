import { createSvgEl } from "../dom.js";
import { EARTH_RADIUS } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";

const METERS_PER_MILE = 1609.344;

export type GraticuleUnits = "degrees" | "map" | "kilometers" | "miles";

export interface GraticuleLayerOptions extends LayerOptions {
  step?: number | "auto";
  units?: GraticuleUnits;
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
      maxLines: 200,
      ...options
    } as Required<GraticuleLayerOptions>);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.svg = createSvgEl("svg");
    this.svg.classList.add("oh-graticule-layer");
    this.svg.style.position = "absolute";
    this.svg.style.inset = "0";
    this.svg.style.pointerEvents = "none";
    this.path = createSvgEl("path", this.svg);
    this.path.setAttribute("fill", "none");
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
    const units = this.options.units;
    const distanceUnits = units === "kilometers" || units === "miles";
    const incompatible = this.map.crs.code === "Simple"
      ? units !== "map"
      : units === "map";
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
    const midLat = (bounds.north + bounds.south) / 2;
    const xSpan = Math.abs(bounds.east - bounds.west);
    const ySpan = Math.abs(bounds.north - bounds.south);
    const lines: string[] = [];
    const maxLines = Math.max(2, this.options.maxLines);

    if (distanceUnits) {
      const toMeters = units === "miles" ? METERS_PER_MILE : 1000;
      const xSpanMeters = xSpan * metersPerDegreeLng(midLat);
      const ySpanMeters = ySpan * metersPerDegreeLat();
      const stepMeters = typeof this.options.step === "number"
        ? Math.max(Number.EPSILON, Math.abs(this.options.step) * toMeters)
        : niceStep(Math.max(xSpanMeters, ySpanMeters) / 7, Infinity);
      // Keep axes independent and coarsen if denser than maxLines so the grid still spans the view.
      const lngStep = fitStep(xSpan, stepMeters / Math.max(metersPerDegreeLng(midLat), Number.EPSILON), maxLines);
      const latStep = fitStep(ySpan, stepMeters / metersPerDegreeLat(), maxLines);
      appendMeridians(this.map, lines, bounds, lngStep, maxLines);
      appendParallels(this.map, lines, bounds, latStep, maxLines);
    } else {
      const step = typeof this.options.step === "number"
        ? Math.max(Number.EPSILON, Math.abs(this.options.step))
        : niceStep(Math.max(xSpan, ySpan) / 7, units === "degrees" ? 90 : Infinity);
      const lngStep = fitStep(xSpan, step, maxLines);
      const latStep = fitStep(ySpan, step, maxLines);
      appendMeridians(this.map, lines, bounds, lngStep, maxLines);
      appendParallels(this.map, lines, bounds, latStep, maxLines);
    }

    this.path.setAttribute("d", lines.join(""));
  }
}

function fitStep(span: number, step: number, maxLines: number): number {
  const safeStep = Math.max(Number.EPSILON, Math.abs(step));
  const needed = Math.floor(span / safeStep) + 2;
  if (needed <= maxLines) return safeStep;
  return Math.max(safeStep, span / Math.max(1, maxLines - 1));
}

function appendMeridians(
  map: Orihon,
  lines: string[],
  bounds: { south: number; north: number; west: number; east: number },
  step: number,
  maxLines: number
): void {
  const start = Math.ceil(bounds.west / step) * step;
  for (let i = 0; i < maxLines; i++) {
    const x = start + i * step;
    if (x > bounds.east) break;
    const a = map.latLngToLayerPoint({ lat: bounds.south, lng: x });
    const b = map.latLngToLayerPoint({ lat: bounds.north, lng: x });
    lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
}

function appendParallels(
  map: Orihon,
  lines: string[],
  bounds: { south: number; north: number; west: number; east: number },
  step: number,
  maxLines: number
): void {
  const start = Math.ceil(bounds.south / step) * step;
  for (let i = 0; i < maxLines; i++) {
    const y = start + i * step;
    if (y > bounds.north) break;
    const a = map.latLngToLayerPoint({ lat: y, lng: bounds.west });
    const b = map.latLngToLayerPoint({ lat: y, lng: bounds.east });
    lines.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
}

function metersPerDegreeLat(): number {
  return (Math.PI / 180) * EARTH_RADIUS;
}

function metersPerDegreeLng(lat: number): number {
  return metersPerDegreeLat() * Math.max(0.01, Math.cos((lat * Math.PI) / 180));
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
