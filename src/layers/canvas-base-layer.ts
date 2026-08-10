import { TILE_SIZE, project, unproject } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";

export interface CanvasBaseLayerOptions extends LayerOptions {
  background?: string;
  water?: string;
  grid?: string;
  majorGrid?: string;
  road?: string;
  roadStroke?: string;
  text?: string;
}

type ResolvedCanvasOptions = Required<Omit<CanvasBaseLayerOptions, "pane" | "attribution">> &
  Pick<CanvasBaseLayerOptions, "pane" | "attribution">;

interface RoadHint {
  y: number;
  amp: number;
  phase: number;
  width: number;
}

export class CanvasBaseLayer extends Layer<ResolvedCanvasOptions> {
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;

  constructor(options: CanvasBaseLayerOptions = {}) {
    super({
      background: "#edf3f7",
      water: "#c7ddeb",
      grid: "rgba(74, 96, 112, .22)",
      majorGrid: "rgba(43, 62, 76, .36)",
      road: "rgba(250, 250, 246, .92)",
      roadStroke: "rgba(148, 163, 184, .5)",
      text: "#52616c",
      ...options
    } as ResolvedCanvasOptions);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "oh-canvas-base";
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    map.viewport.insertBefore(this.canvas, map.panes.tile);
    this.render();
  }

  override onRemove(): void {
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.canvas || !this.ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.map.size.width));
    const height = Math.max(1, Math.round(this.map.size.height));
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }

    const context = this.ctx;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = this.options.background;
    context.fillRect(0, 0, width, height);
    this.#drawWater(context, width, height);
    this.#drawTileGrid(context, width, height);
    this.#drawRoadHints(context, width, height);
    this.#drawLabels(context, width, height);
  }

  #drawWater(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.map) return;
    const center = this.map.latLngToContainerPoint(this.map.center);
    context.save();
    context.fillStyle = this.options.water;
    context.beginPath();
    context.ellipse(center.x - width * 0.28, center.y + height * 0.2, width * 0.55, height * 0.18, -0.22, 0, Math.PI * 2);
    context.ellipse(center.x + width * 0.32, center.y - height * 0.24, width * 0.42, height * 0.14, 0.4, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  #drawTileGrid(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.map) return;
    const zoom = Math.round(this.map.zoom);
    const northWest = project(this.map.containerPointToLatLng({ x: 0, y: 0 }), zoom);
    const southEast = project(this.map.containerPointToLatLng({ x: width, y: height }), zoom);
    const startX = Math.floor(northWest.x / TILE_SIZE) * TILE_SIZE;
    const startY = Math.floor(northWest.y / TILE_SIZE) * TILE_SIZE;
    const displayScale = 2 ** (this.map.zoom - zoom);

    context.save();
    context.lineWidth = 1;
    context.font = "12px system-ui, sans-serif";
    context.textBaseline = "top";
    for (let x = startX; x <= southEast.x + TILE_SIZE; x += TILE_SIZE) {
      const screenX = (x - northWest.x) * displayScale;
      context.strokeStyle = x % (TILE_SIZE * 4) === 0 ? this.options.majorGrid : this.options.grid;
      context.beginPath();
      context.moveTo(screenX, 0);
      context.lineTo(screenX, height);
      context.stroke();
    }
    for (let y = startY; y <= southEast.y + TILE_SIZE; y += TILE_SIZE) {
      const screenY = (y - northWest.y) * displayScale;
      context.strokeStyle = y % (TILE_SIZE * 4) === 0 ? this.options.majorGrid : this.options.grid;
      context.beginPath();
      context.moveTo(0, screenY);
      context.lineTo(width, screenY);
      context.stroke();
    }
    context.restore();
  }

  #drawRoadHints(context: CanvasRenderingContext2D, width: number, height: number): void {
    const roads: RoadHint[] = [
      { y: 0.28, amp: 38, phase: 0, width: 8 },
      { y: 0.52, amp: 26, phase: 1.8, width: 6 },
      { y: 0.7, amp: 34, phase: 3.2, width: 5 }
    ];
    context.save();
    for (const road of roads) {
      this.#roadPath(context, width, height, road);
      context.strokeStyle = this.options.roadStroke;
      context.lineWidth = road.width + 2;
      context.stroke();
      this.#roadPath(context, width, height, road);
      context.strokeStyle = this.options.road;
      context.lineWidth = road.width;
      context.stroke();
    }
    context.restore();
  }

  #roadPath(context: CanvasRenderingContext2D, width: number, height: number, road: RoadHint): void {
    if (!this.map) return;
    context.beginPath();
    for (let x = -20; x <= width + 20; x += 36) {
      const y = height * road.y + Math.sin(x / 120 + road.phase + this.map.center.lng / 20) * road.amp;
      if (x < 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
  }

  #drawLabels(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.map) return;
    const center = this.map.center;
    const corners = [
      unproject({ x: this.map.pixelOrigin.x, y: this.map.pixelOrigin.y }, this.map.zoom),
      unproject({ x: this.map.pixelOrigin.x + width, y: this.map.pixelOrigin.y + height }, this.map.zoom)
    ];
    context.save();
    context.fillStyle = this.options.text;
    context.font = "600 13px system-ui, sans-serif";
    context.fillText(`z${this.map.zoom.toFixed(2)}  ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`, 14, 16);
    context.font = "12px system-ui, sans-serif";
    context.fillText(`${corners[0].lat.toFixed(2)}, ${corners[0].lng.toFixed(2)}`, 14, height - 42);
    context.fillText(`${corners[1].lat.toFixed(2)}, ${corners[1].lng.toFixed(2)}`, 14, height - 24);
    context.restore();
  }
}

export function canvasBaseLayer(options?: CanvasBaseLayerOptions): CanvasBaseLayer {
  return new CanvasBaseLayer(options);
}
