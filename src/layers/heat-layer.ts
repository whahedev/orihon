import { createEl } from "../dom.js";
import { latLng, type LatLngLike } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";

export type HeatPoint = LatLngLike | [number, number, number?];

export interface HeatLayerOptions extends LayerOptions {
  /** Screen-pixel radius at `scaleZoom`. */
  radius?: number;
  blur?: number;
  /** Zoom level at which `radius` / `blur` are defined. Defaults to map zoom when the layer is added. */
  scaleZoom?: number;
  /** Floor for screen radius when zoomed far out (px). */
  minRadius?: number;
  /** Cap for screen radius when zoomed in (px). Defaults to ~14% of the shorter map side. */
  maxRadius?: number;
  maxZoom?: number;
  max?: number;
  minOpacity?: number;
  gradient?: Record<number, string>;
  /**
   * Internal heat buffer device-pixel ratio cap.
   * Heat colorize is CPU-bound; default 1 keeps leaflet.heat-class cost.
   */
  maxDpr?: number;
}

type ResolvedHeatLayerOptions = Required<
  Omit<HeatLayerOptions, "pane" | "attribution" | "scaleZoom" | "maxRadius">
> &
  Pick<HeatLayerOptions, "pane" | "attribution" | "scaleZoom" | "maxRadius">;

interface NormalizedHeatPoint {
  lat: number;
  lng: number;
  alt: number;
}

const DEFAULT_GRADIENT: Record<number, string> = {
  0.4: "blue",
  0.6: "cyan",
  0.7: "lime",
  0.8: "yellow",
  1.0: "red"
};

/**
 * Canvas heatmap (Leaflet.heat / simpleheat family).
 * Redraws on moveend/zoomend/resize — not on every pan frame (matches Leaflet.heat).
 */
export class HeatLayer extends Layer<ResolvedHeatLayerOptions> {
  private latlngs: NormalizedHeatPoint[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private brush: HTMLCanvasElement | null = null;
  private brushRadius = 0;
  private frame = 0;
  private grad: HTMLCanvasElement | null = null;
  private scaleZoom: number | undefined;
  private palette: Uint8ClampedArray | undefined;
  private readonly redrawSoonBound = (): void => this.redrawSoon();

  constructor(latlngs: HeatPoint[] = [], options: HeatLayerOptions = {}) {
    super({
      pane: "overlay",
      radius: 25,
      blur: 15,
      minRadius: 6,
      maxZoom: 18,
      max: 1,
      minOpacity: 0.05,
      gradient: DEFAULT_GRADIENT,
      maxDpr: 1,
      ...options
    });
    this.latlngs = normalizePoints(latlngs);
    if (options.scaleZoom != null) this.scaleZoom = options.scaleZoom;
  }

  setLatLngs(latlngs: HeatPoint[]): this {
    this.latlngs = normalizePoints(latlngs);
    return this.redraw();
  }

  addLatLng(latlng: HeatPoint): this {
    this.latlngs.push(...normalizePoints([latlng]));
    return this.redraw();
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-heat-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    // willReadFrequently: colorize reads back the intensity buffer each redraw.
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true, alpha: true });
    this.grad = this.createGradient();
    if (this.scaleZoom == null) this.scaleZoom = map.getZoom();
    // Leaflet.heat: moveend only — continuous `move`/`render` would force full CPU redraws.
    map.on("moveend", this.redrawSoonBound);
    map.on("zoomend", this.redrawSoonBound);
    map.on("resize", this.redrawSoonBound);
    this.redrawSoon();
  }

  override onRemove(): void {
    this.map?.off("moveend", this.redrawSoonBound);
    this.map?.off("zoomend", this.redrawSoonBound);
    this.map?.off("resize", this.redrawSoonBound);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
    }
    this.canvas = null;
    this.ctx = null;
    this.brush = null;
    this.brushRadius = 0;
    this.grad = null;
    this.palette = undefined;
    this.latlngs = [];
    super.onRemove();
  }

  redraw(): this {
    if (this.map) this.redrawSoon();
    return this;
  }

  /** Map calls this every view frame — do not full-repaint heat here. */
  override render(): void {
    /* intentional no-op: heat is moveend-driven like Leaflet.heat */
  }

  private redrawSoon = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.redrawInternal();
    });
  };

  private redrawInternal(): void {
    const map = this.map;
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!map || !canvas || !ctx) return;

    const size = map.getSize();
    if (size.x < 1 || size.y < 1) return;

    const dpr = Math.min(window.devicePixelRatio || 1, this.options.maxDpr);
    const cssW = Math.max(1, Math.round(size.x));
    const cssH = Math.max(1, Math.round(size.y));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    canvas.style.left = "0px";
    canvas.style.top = "0px";

    const zoom = map.getZoom();
    const scaleZoom = this.scaleZoom ?? zoom;
    const zoomScale = heatZoomScale(zoom, scaleZoom);
    const baseRadius = this.options.radius;
    const baseBlur = this.options.blur;
    const minR = this.options.minRadius;
    const maxR = this.options.maxRadius ?? Math.max(baseRadius * 1.2, Math.min(size.x, size.y) * 0.14);
    const screenR = clamp(baseRadius * zoomScale, minR, maxR);
    const screenBlur = Math.max(screenR * 0.55, Math.min(baseBlur * zoomScale, screenR * 0.9));
    const r = Math.max(1, Math.round((screenR + screenBlur * 0.35) * dpr));
    const max = this.options.max;
    const maxZoom = this.options.maxZoom;
    // Leaflet.heat intensity scale by zoom — keeps low-z stamps from blowing out.
    const intensityScale = 1 / Math.pow(2, Math.max(0, Math.min(maxZoom - zoom, 12)));

    // Screen-space cells (Leaflet.heat): ~r/2 in CSS px, mapped to buffer px.
    const cell = Math.max(1, (r / 2) | 0);
    const grid: Array<Array<[number, number, number] | undefined> | undefined> = [];
    const pad = r;

    for (const p of this.latlngs) {
      const pt = map.latLngToContainerPoint([p.lat, p.lng]);
      const x = pt.x * dpr;
      const y = pt.y * dpr;
      if (x < -pad || y < -pad || x > w + pad || y > h + pad) continue;
      const gx = ((x / cell) | 0) + 2;
      const gy = ((y / cell) | 0) + 2;
      const weight = p.alt * intensityScale;
      const row = grid[gy] || (grid[gy] = []);
      const cellVal = row[gx];
      if (!cellVal) {
        row[gx] = [x, y, weight];
      } else {
        const wSum = cellVal[2] + weight;
        cellVal[0] = (cellVal[0] * cellVal[2] + x * weight) / wSum;
        cellVal[1] = (cellVal[1] * cellVal[2] + y * weight) / wSum;
        cellVal[2] = wSum;
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const brush = this.ensureBrush(r);
    const half = r;
    let stamped = 0;
    for (let gy = 0; gy < grid.length; gy++) {
      const row = grid[gy];
      if (!row) continue;
      for (let gx = 0; gx < row.length; gx++) {
        const cellVal = row[gx];
        if (!cellVal) continue;
        const alpha = Math.min(1, cellVal[2] / max);
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        ctx.drawImage(brush, cellVal[0] - half, cellVal[1] - half);
        stamped += 1;
      }
    }
    ctx.globalAlpha = 1;
    if (stamped === 0) return;

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const palette = this.gradientPalette();
    const minOpacity = this.options.minOpacity;

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      if (a < minOpacity) {
        data[i + 3] = 0;
        continue;
      }
      const idx = Math.min(255, (a * 255) | 0) * 4;
      data[i] = palette[idx];
      data[i + 1] = palette[idx + 1];
      data[i + 2] = palette[idx + 2];
      data[i + 3] = Math.min(255, (a * 230) | 0);
    }
    ctx.putImageData(img, 0, 0);
  }

  private ensureBrush(radius: number): HTMLCanvasElement {
    if (this.brush && this.brushRadius === radius) return this.brush;
    const d = Math.max(2, radius * 2);
    const c = document.createElement("canvas");
    c.width = d;
    c.height = d;
    const bctx = c.getContext("2d");
    if (bctx) {
      const grd = bctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
      grd.addColorStop(0, "rgba(0,0,0,1)");
      grd.addColorStop(0.45, "rgba(0,0,0,0.45)");
      grd.addColorStop(1, "rgba(0,0,0,0)");
      bctx.fillStyle = grd;
      bctx.fillRect(0, 0, d, d);
    }
    this.brush = c;
    this.brushRadius = radius;
    return c;
  }

  private gradientPalette(): Uint8ClampedArray {
    if (this.palette) return this.palette;
    const c = this.grad ?? this.createGradient();
    this.palette = c.getContext("2d")!.getImageData(0, 0, 256, 1).data;
    return this.palette;
  }

  private createGradient(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 1;
    const ctx = c.getContext("2d");
    if (!ctx) return c;
    const grd = ctx.createLinearGradient(0, 0, 256, 0);
    const stops = this.options.gradient;
    for (const [stop, color] of Object.entries(stops)) {
      grd.addColorStop(Number(stop), color);
    }
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 256, 1);
    this.grad = c;
    this.palette = undefined;
    return c;
  }
}

function normalizePoints(latlngs: HeatPoint[]): NormalizedHeatPoint[] {
  return latlngs.map((p) => {
    if (Array.isArray(p)) return { lat: p[0], lng: p[1], alt: p[2] ?? 1 };
    const ll = latLng(p);
    return { lat: ll.lat, lng: ll.lng, alt: 1 };
  });
}

function heatZoomScale(zoom: number, scaleZoom: number): number {
  const dz = zoom - scaleZoom;
  if (dz === 0) return 1;
  if (dz < 0) {
    const geo = Math.pow(2, dz);
    return Math.max(0.18, geo * 0.55 + 0.45 * Math.pow(geo, 0.35));
  }
  const maxIn = 1.55;
  return 1 + (maxIn - 1) * (1 - Math.exp(-dz * 0.42));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function heatLayer(latlngs?: HeatPoint[], options?: HeatLayerOptions): HeatLayer {
  return new HeatLayer(latlngs, options);
}
