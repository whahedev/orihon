import { createEl } from "../dom.js";
import { latLng, type LatLng } from "../geo.js";
import { Layer, type LayerOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import {
  isReadonlyFeatureSource
} from "../source-protocol.js";
import type { ReadonlyFeatureSource } from "../source-types.js";
import { pickLabelAnchor } from "../services/label-layout.js";
import type { GeoJSONFeature, GeoJSONFeatureCollection, GeoJSONPosition } from "./geojson.js";

export interface TextLayerOptions extends LayerOptions {
  text: (feature: GeoJSONFeature) => string;
  minZoom?: number;
  maxZoom?: number;
  font?: string;
  fill?: string;
  halo?: string;
  haloWidth?: number;
  offset?: [number, number];
  collision?: boolean;
  collisionPadding?: number;
  placement?: "point" | "line";
  maxLabels?: number;
  priority?: (feature: GeoJSONFeature) => number;
  maxDpr?: number;
}

interface VisibleLabel {
  feature: GeoJSONFeature;
  text: string;
  anchor: LatLng;
}

interface Box { left: number; top: number; right: number; bottom: number }

export interface TextLayerEventMap {
  layout: { count: number };
}

export class TextLayer extends Layer<Required<TextLayerOptions>, TextLayerEventMap> {
  private features: GeoJSONFeature[];
  private readonly source: ReadonlyFeatureSource<GeoJSONFeature> | null;
  private sourceUnsubscribe: (() => void) | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private visible: VisibleLabel[] = [];
  private readonly rebuildOnSettle = (): void => { this.rebuild(); };
  private readonly sourceChanged = (): void => {
    if (this.source) this.setData([...this.source.getSnapshot().features]);
  };

  constructor(features: GeoJSONFeature[] | GeoJSONFeatureCollection | ReadonlyFeatureSource<GeoJSONFeature>, options: TextLayerOptions) {
    if (typeof options?.text !== "function") throw new TypeError("TextLayer requires a text(feature) function");
    super({
      pane: "overlay",
      attribution: "",
      minZoom: 0,
      maxZoom: Infinity,
      font: "12px system-ui",
      fill: "#111827",
      halo: "#fff",
      haloWidth: 2,
      offset: [0, -8],
      collision: true,
      collisionPadding: 4,
      placement: "point",
      maxLabels: 500,
      priority: () => 0,
      maxDpr: 2,
      ...options
    } as Required<TextLayerOptions>);
    this.source = isReadonlyFeatureSource<GeoJSONFeature>(features) ? features : null;
    this.features = this.source
      ? [...this.source.getSnapshot().features]
      : Array.isArray(features)
        ? [...features]
        : [...(features as GeoJSONFeatureCollection).features];
  }

  setData(features: GeoJSONFeature[] | GeoJSONFeatureCollection): this {
    this.features = Array.isArray(features) ? [...features] : [...features.features];
    return this.rebuild();
  }

  getVisibleLabels(): ReadonlyArray<{ feature: GeoJSONFeature; text: string; anchor: LatLng }> {
    return this.visible.map((label) => ({ ...label, anchor: label.anchor.clone() }));
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (this.source) {
      this.setData([...this.source.getSnapshot().features]);
      this.sourceUnsubscribe = this.source.subscribe(this.sourceChanged);
    }
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.canvas = createEl("canvas", "oh-text-layer", pane);
    this.canvas.style.position = "absolute";
    this.canvas.style.left = "0";
    this.canvas.style.top = "0";
    this.canvas.style.pointerEvents = "none";
    map.on("moveend", this.rebuildOnSettle);
    map.on("zoomend", this.rebuildOnSettle);
    map.on("resize", this.rebuildOnSettle);
    this.rebuild();
  }

  override onRemove(): void {
    this.sourceUnsubscribe?.();
    this.sourceUnsubscribe = null;
    this.map?.off("moveend", this.rebuildOnSettle);
    this.map?.off("zoomend", this.rebuildOnSettle);
    this.map?.off("resize", this.rebuildOnSettle);
    this.canvas?.remove();
    this.canvas = null;
    this.visible = [];
    super.onRemove();
  }

  rebuild(): this {
    if (!this.map || !this.canvas) return this;
    const ctx = this.#context();
    if (!ctx || this.map.zoom < this.options.minZoom || this.map.zoom > this.options.maxZoom) {
      this.visible = [];
      this.render();
      return this;
    }
    ctx.font = this.options.font;
    const rtl = Boolean(this.map.locale.rtl);
    const padding = this.options.collisionPadding;
    const fontHeight = Number(this.options.font.match(/([\d.]+)px/)?.[1] ?? 12);
    const boxes: Box[] = [];
    const candidates = this.features
      .map((feature, index) => ({ feature, index, priority: Number(this.options.priority(feature)) || 0 }))
      .sort((a, b) => b.priority - a.priority || a.index - b.index);
    const visible: VisibleLabel[] = [];
    for (const { feature } of candidates) {
      if (visible.length >= this.options.maxLabels) break;
      const text = String(this.options.text(feature) ?? "").trim();
      if (!text) continue;
      const anchor = this.#featureAnchor(feature);
      if (!anchor) continue;
      const screen = this.map.latLngToContainerPoint(anchor).add(this.options.offset);
      const textWidth = ctx.measureText(text).width;
      const box: Box = {
        left: (rtl ? screen.x - textWidth : screen.x) - padding,
        top: screen.y - fontHeight / 2 - padding,
        right: (rtl ? screen.x : screen.x + textWidth) + padding,
        bottom: screen.y + fontHeight / 2 + padding
      };
      if (box.right < 0 || box.bottom < 0 || box.left > this.map.size.width || box.top > this.map.size.height) continue;
      if (this.options.collision && boxes.some((other) => box.left < other.right && box.right > other.left
        && box.top < other.bottom && box.bottom > other.top)) continue;
      boxes.push(box);
      visible.push({ feature, text, anchor });
    }
    this.visible = visible;
    this.render();
    this.emit("layout", { count: visible.length });
    return this;
  }

  override render(): void {
    if (!this.map || !this.canvas) return;
    const ctx = this.#context();
    if (!ctx) return;
    ctx.clearRect(0, 0, this.map.size.width, this.map.size.height);
    if (this.map.zoom < this.options.minZoom || this.map.zoom > this.options.maxZoom) return;
    const rtl = Boolean(this.map.locale.rtl);
    ctx.font = this.options.font;
    ctx.textAlign = rtl ? "right" : "left";
    ctx.textBaseline = "middle";
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.lineJoin = "round";
    for (const label of this.visible) {
      const point = this.map.latLngToContainerPoint(label.anchor).add(this.options.offset);
      if (this.options.haloWidth > 0) {
        ctx.strokeStyle = this.options.halo;
        ctx.lineWidth = this.options.haloWidth * 2;
        ctx.strokeText(label.text, point.x, point.y);
      }
      ctx.fillStyle = this.options.fill;
      ctx.fillText(label.text, point.x, point.y);
    }
  }

  #context(): CanvasRenderingContext2D | null {
    if (!this.map || !this.canvas) return null;
    const dpr = Math.min(this.options.maxDpr, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(this.map.size.width * dpr));
    const height = Math.max(1, Math.round(this.map.size.height * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.style.width = `${this.map.size.width}px`;
    this.canvas.style.height = `${this.map.size.height}px`;
    const ctx = this.canvas.getContext("2d");
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  #featureAnchor(feature: GeoJSONFeature): LatLng | null {
    const geometry = feature.geometry;
    if (!geometry) return null;
    if (this.options.placement === "line") {
      const lines: GeoJSONPosition[][] = geometry.type === "LineString" ? [geometry.coordinates]
        : geometry.type === "MultiLineString" ? geometry.coordinates
          : geometry.type === "Polygon" ? geometry.coordinates : [];
      let best: { points: ReturnType<Orihon["latLngToContainerPoint"]>[]; length: number } | null = null;
      for (const line of lines) {
        const points = line.map((coordinate) => this.map!.latLngToContainerPoint({ lat: coordinate[1], lng: coordinate[0] }));
        let length = 0;
        for (let index = 1; index < points.length; index++) length += points[index].distanceTo(points[index - 1]);
        if (!best || length > best.length) best = { points, length };
      }
      if (!best) return null;
      const point = pickLabelAnchor(best.points, best.length, this.map!.size.width, this.map!.size.height, 0);
      return point ? this.map!.containerPointToLatLng(point) : null;
    }
    const coordinates: GeoJSONPosition[] = geometry.type === "Point" ? [geometry.coordinates]
      : geometry.type === "MultiPoint" || geometry.type === "LineString" ? geometry.coordinates
        : geometry.type === "MultiLineString" || geometry.type === "Polygon" ? geometry.coordinates[0]
          : geometry.type === "MultiPolygon" ? geometry.coordinates[0]?.[0] ?? [] : [];
    if (!coordinates.length) return null;
    const sum = coordinates.reduce((result, coordinate) => [result[0] + coordinate[1], result[1] + coordinate[0]], [0, 0]);
    return latLng({ lat: sum[0] / coordinates.length, lng: sum[1] / coordinates.length });
  }
}

export function textLayer(
  features: GeoJSONFeature[] | GeoJSONFeatureCollection | ReadonlyFeatureSource<GeoJSONFeature>,
  options: TextLayerOptions
): TextLayer {
  return new TextLayer(features, options);
}
