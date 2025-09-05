import { listen } from "../dom.js";
import {
  EARTH_RADIUS,
  LatLng,
  LatLngBounds,
  latLng,
  latLngBounds,
  metersToPixels,
  type LatLngBoundsLike,
  type LatLngLike
} from "../geo.js";
import type { Orihon } from "../map.js";
import { Renderer, type RendererOptions } from "../renderer.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface PathOptions extends RendererOptions {
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  fill?: string;
  fillOpacity?: number;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
  interactive?: boolean;
  smoothFactor?: number;
  noClip?: boolean;
  clipPadding?: number;
}

type ResolvedPathOptions = Required<Omit<PathOptions, "pane" | "attribution" | "className">> &
  Pick<PathOptions, "pane" | "attribution" | "className">;

export class SvgLayer<TOptions extends RendererOptions = RendererOptions> extends Renderer<TOptions> {
  svg: SVGSVGElement | null = null;
  group: SVGGElement | null = null;

  protected override createContainer(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("oh-svg-layer");
    return svg;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.svg = this.container as SVGSVGElement;
    this.group = document.createElementNS(SVG_NS, "g");
    this.svg.appendChild(this.group);
    this.render();
  }

  override onRemove(): void {
    this.group = null;
    this.svg = null;
    super.onRemove();
  }

  override render(): void {
    if (!this.map || !this.svg) return;
    const { width, height } = this.map.size;
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.style.left = "0px";
    this.svg.style.top = "0px";
  }
}

export class PathLayer extends SvgLayer<ResolvedPathOptions> {
  path: SVGPathElement | null = null;
  readonly _pathUnsub: Array<() => void> = [];

  constructor(options: PathOptions = {}) {
    super({
      pane: "overlay",
      stroke: "#2563eb",
      strokeWidth: 3,
      strokeOpacity: 1,
      fill: "none",
      fillOpacity: 0.18,
      lineCap: "round",
      lineJoin: "round",
      interactive: true,
      smoothFactor: 1,
      noClip: false,
      clipPadding: 64,
      ...options
    } as ResolvedPathOptions);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.group) return;
    this.path = document.createElementNS(SVG_NS, "path");
    this.group.appendChild(this.path);
    this.#style();
    if (this.options.interactive) {
      this.path.classList.add("oh-interactive");
      this.path.style.pointerEvents = "visiblePainted";
      this._pathUnsub.push(listen(this.path, "click", (event) => {
        event.stopPropagation();
        this.emit("click", { originalEvent: event, latlng: this.#eventLatLng(event) });
      }));
      this._pathUnsub.push(listen(this.path, "pointerenter", (event) => {
        this.emit("mouseover", { originalEvent: event, latlng: this.#eventLatLng(event) });
      }));
      this._pathUnsub.push(listen(this.path, "pointerleave", (event) => {
        this.emit("mouseout", { originalEvent: event, latlng: this.#eventLatLng(event) });
      }));
    }
    this.render();
  }

  override onRemove(): void {
    for (const unsubscribe of this._pathUnsub.splice(0)) unsubscribe();
    this.path = null;
    super.onRemove();
  }

  setStyle(style: PathOptions): this {
    Object.assign(this.options, style);
    this.#style();
    return this;
  }

  #style(): void {
    if (!this.path) return;
    this.path.setAttribute("stroke", this.options.stroke);
    this.path.setAttribute("stroke-width", String(this.options.strokeWidth));
    this.path.setAttribute("stroke-opacity", String(this.options.strokeOpacity));
    this.path.setAttribute("fill", this.options.fill);
    this.path.setAttribute("fill-opacity", String(this.options.fillOpacity));
    this.path.setAttribute("stroke-linecap", this.options.lineCap);
    this.path.setAttribute("stroke-linejoin", this.options.lineJoin);
  }

  #eventLatLng(event: PointerEvent | MouseEvent): LatLng {
    if (!this.map) return latLng([0, 0]);
    const rect = this.map.container.getBoundingClientRect();
    return this.map.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top]);
  }
}

interface ProjectedBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PointLikeXY {
  x: number;
  y: number;
}

export function projectedBounds(points: PointLikeXY[]): ProjectedBounds {
  const result = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };
  for (const point of points) {
    result.minX = Math.min(result.minX, point.x);
    result.minY = Math.min(result.minY, point.y);
    result.maxX = Math.max(result.maxX, point.x);
    result.maxY = Math.max(result.maxY, point.y);
  }
  return result;
}

export function projectedBoundsIntersectsViewport(map: Orihon, bounds: ProjectedBounds, padding = 64): boolean {
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) return false;
  return bounds.maxX >= -padding
    && bounds.minX <= map.size.width + padding
    && bounds.maxY >= -padding
    && bounds.minY <= map.size.height + padding;
}

function perpendicularDistance(point: PointLikeXY, start: PointLikeXY, end: PointLikeXY): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.hypot(dx, dy);
}

export function simplifyProjectedPoints(points: PointLikeXY[], tolerance = 1): PointLikeXY[] {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let maxDistance = 0;
    let index = start;
    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularDistance(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        index = i;
        maxDistance = distance;
      }
    }
    if (maxDistance > tolerance) {
      keep[index] = 1;
      if (index - start > 1) stack.push([start, index]);
      if (end - index > 1) stack.push([index, end]);
    }
  }
  const result: PointLikeXY[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

export function projectedPointsToPath(points: PointLikeXY[], close = false): string {
  let d = "";
  for (let index = 0; index < points.length; index++) {
    const projected = points[index];
    d += `${index ? "L" : "M"}${projected.x.toFixed(1)} ${projected.y.toFixed(1)}`;
  }
  return close && d ? `${d}Z` : d;
}

export class Polyline extends PathLayer {
  points: LatLng[];

  constructor(points: LatLngLike[], options?: PathOptions) {
    super(options);
    this.points = points.map((value) => latLng(value));
  }

  setLatLngs(points: LatLngLike[]): this {
    this.points = points.map((value) => latLng(value));
    this.render();
    return this;
  }

  getLatLngs(): LatLng[] | LatLng[][] {
    return this.points.map((value) => value.clone());
  }

  getBounds(): LatLngBounds {
    const result = new LatLngBounds();
    for (const value of this.points) result.extend(value);
    return result;
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    const points = this.points.map((value) => this.map!.latLngToLayerPoint(value));
    if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, projectedBounds(points), this.options.clipPadding)) {
      this.path.setAttribute("d", "");
      return;
    }
    this.path.setAttribute("d", projectedPointsToPath(simplifyProjectedPoints(points, this.options.smoothFactor)));
  }
}

function normalizeRings(points: LatLngLike[] | LatLngLike[][]): LatLng[][] {
  const source = points as unknown[];
  const first = source[0] as unknown;
  const nested = Array.isArray(first) && first.length > 0 && Array.isArray(first[0]);
  return (nested ? points as LatLngLike[][] : [points as LatLngLike[]])
    .map((ring) => ring.map((value) => latLng(value)));
}

export class Polygon extends Polyline {
  rings: LatLng[][];

  constructor(points: LatLngLike[] | LatLngLike[][], options: PathOptions = {}) {
    const rings = normalizeRings(points);
    super(rings[0] ?? [], { fill: options.fill ?? "#2563eb", ...options });
    this.rings = rings;
  }

  override setLatLngs(points: LatLngLike[] | LatLngLike[][]): this {
    this.rings = normalizeRings(points);
    this.points = this.rings[0] ?? [];
    this.render();
    return this;
  }

  override getLatLngs(): LatLng[][] {
    return this.rings.map((ring) => ring.map((value) => value.clone()));
  }

  override getBounds(): LatLngBounds {
    const result = new LatLngBounds();
    for (const ring of this.rings) {
      for (const value of ring) result.extend(value);
    }
    return result;
  }

  override render(): void {
    PathLayer.prototype.render.call(this);
    if (!this.map || !this.path) return;
    const projectedRings = this.rings.map((ring) => ring.map((value) => this.map!.latLngToLayerPoint(value)));
    const allPoints = projectedRings.flat();
    if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, projectedBounds(allPoints), this.options.clipPadding)) {
      this.path.setAttribute("d", "");
      return;
    }
    const path = projectedRings
      .map((points) => projectedPointsToPath(simplifyProjectedPoints(points, this.options.smoothFactor), true))
      .join("");
    this.path.setAttribute("fill-rule", "evenodd");
    this.path.setAttribute("d", path);
  }
}

export class Rectangle extends Polygon {
  rectangleBounds: LatLngBounds;

  constructor(value: LatLngBoundsLike, options: PathOptions = {}) {
    const target = latLngBounds(value);
    super([
      target.getNorthWest(),
      target.getNorthEast(),
      target.getSouthEast(),
      target.getSouthWest()
    ], options);
    this.rectangleBounds = new LatLngBounds(target);
  }

  setBounds(value: LatLngBoundsLike): this {
    const target = latLngBounds(value);
    this.rectangleBounds = new LatLngBounds(target);
    this.setLatLngs([
      target.getNorthWest(),
      target.getNorthEast(),
      target.getSouthEast(),
      target.getSouthWest()
    ]);
    return this;
  }

  override getBounds(): LatLngBounds {
    return new LatLngBounds(this.rectangleBounds);
  }
}

export class Circle extends PathLayer {
  center: LatLng;
  radiusMeters: number;

  constructor(center: LatLngLike, radiusMeters: number, options?: PathOptions) {
    super(options);
    this.center = latLng(center);
    this.radiusMeters = Number(radiusMeters);
  }

  getLatLng(): LatLng { return this.center.clone(); }
  getRadius(): number { return this.radiusMeters; }

  getBounds(): LatLngBounds {
    const latDelta = (this.radiusMeters / EARTH_RADIUS) * (180 / Math.PI);
    const lngScale = Math.max(1e-6, Math.cos((this.center.lat * Math.PI) / 180));
    const lngDelta = latDelta / lngScale;
    return new LatLngBounds(
      [this.center.lat - latDelta, this.center.lng - lngDelta],
      [this.center.lat + latDelta, this.center.lng + lngDelta]
    );
  }

  setLatLng(value: LatLngLike): this {
    this.center = latLng(value);
    this.render();
    return this;
  }

  setRadius(radiusMeters: number): this {
    this.radiusMeters = Number(radiusMeters);
    this.render();
    return this;
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    const center = this.map.latLngToLayerPoint(this.center);
    const radius = Math.max(1, metersToPixels(this.radiusMeters, this.center.lat, this.map.zoom));
    if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, {
      minX: center.x - radius,
      minY: center.y - radius,
      maxX: center.x + radius,
      maxY: center.y + radius
    }, this.options.clipPadding)) {
      this.path.setAttribute("d", "");
      return;
    }
    this.path.setAttribute(
      "d",
      `M${(center.x - radius).toFixed(1)} ${center.y.toFixed(1)}a${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 0 ${(radius * 2).toFixed(1)} 0a${radius.toFixed(1)} ${radius.toFixed(1)} 0 1 0 ${(-radius * 2).toFixed(1)} 0`
    );
  }
}

export interface CircleMarkerOptions extends PathOptions {
  radius?: number;
}

export class CircleMarker extends PathLayer {
  center: LatLng;
  radiusPixels: number;

  constructor(center: LatLngLike, options: CircleMarkerOptions = {}) {
    super({ fill: options.fill ?? "#2563eb", ...options });
    this.center = latLng(center);
    this.radiusPixels = Math.max(1, Number(options.radius ?? 10));
  }

  getLatLng(): LatLng { return this.center.clone(); }
  getRadius(): number { return this.radiusPixels; }

  setLatLng(value: LatLngLike): this {
    this.center = latLng(value);
    this.render();
    return this;
  }

  setRadius(radiusPixels: number): this {
    this.radiusPixels = Math.max(1, Number(radiusPixels));
    this.render();
    return this;
  }

  getBounds(): LatLngBounds {
    if (!this.map) return new LatLngBounds(this.center, this.center);
    const center = this.map.latLngToContainerPoint(this.center);
    return new LatLngBounds(
      this.map.containerPointToLatLng([center.x - this.radiusPixels, center.y + this.radiusPixels]),
      this.map.containerPointToLatLng([center.x + this.radiusPixels, center.y - this.radiusPixels])
    );
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    const center = this.map.latLngToLayerPoint(this.center);
    const radius = this.radiusPixels;
    if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, {
      minX: center.x - radius,
      minY: center.y - radius,
      maxX: center.x + radius,
      maxY: center.y + radius
    }, this.options.clipPadding)) {
      this.path.setAttribute("d", "");
      return;
    }
    this.path.setAttribute(
      "d",
      `M${(center.x - radius).toFixed(1)} ${center.y.toFixed(1)}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`
    );
  }
}

export function polyline(points: LatLngLike[], options?: PathOptions): Polyline { return new Polyline(points, options); }
export function polygon(points: LatLngLike[] | LatLngLike[][], options?: PathOptions): Polygon { return new Polygon(points, options); }
export function rectangle(value: LatLngBoundsLike, options?: PathOptions): Rectangle { return new Rectangle(value, options); }
export function circle(center: LatLngLike, radiusMeters: number, options?: PathOptions): Circle { return new Circle(center, radiusMeters, options); }
export function circleMarker(center: LatLngLike, options?: CircleMarkerOptions): CircleMarker { return new CircleMarker(center, options); }
