import { createSvgEl, listen, listenTap } from "../dom.js";
import { CRSCompatibilityError } from "../crs.js";
import { nonNegativeFinite, rejectLegacyUnit } from "../units.js";
import { EARTH_RADIUS, destination, geodesicInterpolate, LatLng, LatLngBounds, latLng, bounds, metersToPixels, type LatLngBoundsLike, type LatLngLike } from "../geo.js";
import type { QueryHit, ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions, TooltipOptions } from "../overlays/div-overlay.js";
import { Renderer, type RendererOptions } from "../renderer.js";
import { rejectStyleAliases, type RemovedLineStyleAliases } from "../style-contract.js";

export interface PathOptions extends RendererOptions, RemovedLineStyleAliases {
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  fill?: string;
  fillOpacity?: number;
  lineCap?: CanvasLineCap;
  lineJoin?: CanvasLineJoin;
  dashArray?: string | number[] | null;
  dashOffset?: number;
  geodesic?: boolean;
  arrow?: boolean | "end" | "start" | "both";
  arrowSize?: number;
  interactive?: boolean;
  smoothFactor?: number;
  noClip?: boolean;
  clipPadding?: number;
}

type ResolvedPathOptions = Required<Omit<PathOptions, "pane" | "attribution" | "className">> &
  Pick<PathOptions, "pane" | "attribution" | "className">;

export class SvgLayer<TOptions extends RendererOptions = RendererOptions, TEvents extends object = {}> extends Renderer<TOptions, TEvents> {
  svg: SVGSVGElement | null = null;
  group: SVGGElement | null = null;

  protected override createContainer(): SVGSVGElement {
    const svg = createSvgEl("svg");
    svg.classList.add("oh-svg-layer");
    return svg;
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    this.svg = this.container as SVGSVGElement;
    this.group = createSvgEl("g", this.svg);
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

export interface PathEventMap {
  click: { originalEvent: MouseEvent | PointerEvent; latlng: LatLng };
  mouseover: { originalEvent: PointerEvent; latlng: LatLng };
  mouseout: { originalEvent: PointerEvent; latlng: LatLng };
}

export class PathLayer extends SvgLayer<ResolvedPathOptions, PathEventMap> {
  path: SVGPathElement | SVGCircleElement | null = null;
  readonly _pathUnsub: Array<() => void> = [];
  protected supportsArrows = false;
  private arrowMarker: SVGMarkerElement | null = null;
  private arrowMarkerId = "";

  constructor(options: PathOptions = {}) {
    rejectStyleAliases(options, "line");
    super({
      pane: "overlay",
      stroke: "#2563eb",
      strokeWidth: 3,
      strokeOpacity: 1,
      fill: "none",
      fillOpacity: 0.18,
      lineCap: "round",
      lineJoin: "round",
      dashArray: null,
      dashOffset: 0,
      geodesic: false,
      arrow: false,
      arrowSize: 10,
      interactive: true,
      smoothFactor: 1,
      noClip: false,
      clipPadding: 64,
      ...options
    } as ResolvedPathOptions);
  }

  protected createPathElement(): SVGPathElement | SVGCircleElement {
    return createSvgEl("path");
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    if (!this.group) return;
    this.path = this.createPathElement();
    this.group.appendChild(this.path);
    this.#style();
    this.#syncInteraction();
    this.render();
  }

  override onRemove(): void {
    for (const unsubscribe of this._pathUnsub.splice(0)) unsubscribe();
    this.path = null;
    this.arrowMarker = null;
    this.arrowMarkerId = "";
    super.onRemove();
  }

  setStyle(style: PathOptions): this {
    rejectStyleAliases(style, "line");
    Object.assign(this.writableOptions, style);
    this.#style();
    this.render();
    return this;
  }

  override bindPopup(content: OverlayContent, options?: PopupOptions): this {
    this.setInteractive(true);
    return super.bindPopup(content, options);
  }

  override bindTooltip(content: OverlayContent, options?: TooltipOptions): this {
    this.setInteractive(true);
    return super.bindTooltip(content, options);
  }

  setInteractive(interactive: boolean): this {
    this.writableOptions.interactive = Boolean(interactive);
    this.#syncInteraction();
    return this;
  }

  protected interactionPointerEvents(): "all" | "visiblePainted" {
    return "visiblePainted";
  }

  #syncInteraction(): void {
    for (const unsubscribe of this._pathUnsub.splice(0)) unsubscribe();
    if (!this.path) return;
    if (!this.options.interactive) {
      this.path.classList.remove("oh-interactive");
      this.path.style.pointerEvents = "none";
      return;
    }
    this.path.classList.add("oh-interactive");
    this.path.style.pointerEvents = this.interactionPointerEvents();
    this._pathUnsub.push(listenTap(this.path, (event) => {
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

  #style(): void {
    if (!this.path) return;
    this.path.setAttribute("stroke", this.options.stroke);
    this.path.setAttribute("stroke-width", String(this.options.strokeWidth));
    this.path.setAttribute("stroke-opacity", String(this.options.strokeOpacity));
    this.path.setAttribute("fill", this.options.fill);
    this.path.setAttribute("fill-opacity", String(this.options.fillOpacity));
    this.path.setAttribute("stroke-linecap", this.options.lineCap);
    this.path.setAttribute("stroke-linejoin", this.options.lineJoin);
    const dash = normalizeDashArray(this.options.dashArray);
    if (dash.length) this.path.setAttribute("stroke-dasharray", dash.join(" "));
    else this.path.removeAttribute("stroke-dasharray");
    if (this.options.dashOffset) this.path.setAttribute("stroke-dashoffset", String(this.options.dashOffset));
    else this.path.removeAttribute("stroke-dashoffset");
    this.#styleArrows();
  }

  #styleArrows(): void {
    if (!this.path) return;
    const arrow = this.supportsArrows ? this.options.arrow : false;
    if (!arrow) {
      this.path.removeAttribute("marker-start");
      this.path.removeAttribute("marker-end");
      return;
    }
    if (!this.arrowMarker && this.svg) {
      const defs = createSvgEl("defs");
      const marker = createSvgEl("marker", defs);
      const tip = createSvgEl("path", marker);
      this.arrowMarkerId = `oh-arrow-${++arrowMarkerSequence}`;
      marker.id = this.arrowMarkerId;
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerUnits", "userSpaceOnUse");
      marker.setAttribute("orient", "auto-start-reverse");
      tip.setAttribute("d", "M0 0L10 5L0 10Z");
      this.svg.insertBefore(defs, this.svg.firstChild);
      this.arrowMarker = marker;
    }
    if (!this.arrowMarker) return;
    const size = Math.max(1, Number(this.options.arrowSize));
    this.arrowMarker.setAttribute("markerWidth", String(size));
    this.arrowMarker.setAttribute("markerHeight", String(size));
    this.arrowMarker.firstElementChild?.setAttribute("fill", this.options.stroke);
    const reference = `url(#${this.arrowMarkerId})`;
    const start = arrow === "start" || arrow === "both";
    const end = arrow === true || arrow === "end" || arrow === "both";
    if (start) this.path.setAttribute("marker-start", reference);
    else this.path.removeAttribute("marker-start");
    if (end) this.path.setAttribute("marker-end", reference);
    else this.path.removeAttribute("marker-end");
  }

  #eventLatLng(event: PointerEvent | MouseEvent): LatLng {
    if (!this.map) return latLng({ lat: 0, lng: 0 });
    const rect = this.map.container.getBoundingClientRect();
    return this.map.containerPointToLatLng([event.clientX - rect.left, event.clientY - rect.top]);
  }
}

let arrowMarkerSequence = 0;

export function normalizeDashArray(value: PathOptions["dashArray"]): number[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.trim().split(/[ ,]+/) : [];
  return parts.map(Number).filter((entry) => Number.isFinite(entry) && entry >= 0);
}

export function densifyLatLngs(points: LatLng[], closed = false, maxSegmentMeters = 100_000): LatLng[] {
  if (points.length < 2) return points.map((value) => value.clone());
  const result: LatLng[] = [];
  const segments = closed ? points.length : points.length - 1;
  for (let index = 0; index < segments; index++) {
    const segment = geodesicInterpolate(points[index], points[(index + 1) % points.length], maxSegmentMeters);
    result.push(...(index === 0 ? segment : segment.slice(1)));
  }
  return result;
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

function segmentDistance(target: PointLikeXY, a: PointLikeXY, b: PointLikeXY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return Math.hypot(target.x - a.x, target.y - a.y);
  const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(target.x - (a.x + t * dx), target.y - (a.y + t * dy));
}

function ringContainsPoint(target: PointLikeXY, ring: PointLikeXY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > target.y) !== (b.y > target.y)
      && target.x < ((b.x - a.x) * (target.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x) inside = !inside;
  }
  return inside;
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
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)
    || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.maxY)) return false;
  return bounds.maxX >= -padding
    && bounds.minX <= map.size.width + padding
    && bounds.maxY >= -padding
    && bounds.minY <= map.size.height + padding;
}

function projectedCirclePath(center: PointLikeXY, radius: number): string {
  const r = Math.max(1, Number(radius));
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(r)) return "";
  return `M${center.x - r},${center.y}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
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
  protected override supportsArrows = true;
  private geodesicPoints: LatLng[] | null = null;

  constructor(points: LatLngLike[], options?: PathOptions) {
    super(options);
    this.points = points.map((value) => latLng(value));
    this.geodesicPoints = null;
  }

  setLatLngs(points: LatLngLike[]): this {
    this.points = points.map((value) => latLng(value));
    this.geodesicPoints = null;
    this.render();
    return this;
  }

  getLatLngs(): LatLng[] | LatLng[][] {
    return this.points.map((value) => value.clone());
  }

  getBounds(): LatLngBounds {
    const result = new LatLngBounds();
    const source = this.options.geodesic && this.map?.crs.code !== "Simple" ? this.#densifiedPoints() : this.points;
    for (const value of source) result.extend(value);
    return result;
  }

  queryHit(target: PointLikeXY, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const source = this.options.geodesic && this.map.crs.code === "EPSG:3857" ? this.#densifiedPoints() : this.points;
    const points = source.map((value) => this.map!.latLngToContainerPoint(value));
    const tolerance = options.tolerance + this.options.strokeWidth / 2;
    for (let index = 1; index < points.length; index++) {
      if (segmentDistance(target, points[index - 1], points[index]) <= tolerance) {
        return { layer: this, latlng: this.map.containerPointToLatLng(target), source: "svg" };
      }
    }
    return null;
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    const source = this.options.geodesic && this.map.crs.code === "EPSG:3857" ? this.#densifiedPoints() : this.points;
    const points = source.map((value) => this.map!.latLngToLayerPoint(value));
    if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, projectedBounds(points), this.options.clipPadding)) {
      this.path.setAttribute("d", "");
      return;
    }
    this.path.setAttribute("d", projectedPointsToPath(simplifyProjectedPoints(points, this.options.smoothFactor)));
  }

  #densifiedPoints(): LatLng[] {
    if (this.geodesicPoints) return this.geodesicPoints;
    const result = densifyLatLngs(this.points);
    this.geodesicPoints = result.length ? result : this.points;
    return this.geodesicPoints;
  }
}

function normalizeRings(points: LatLngLike[] | LatLngLike[][]): LatLng[][] {
  const source = points as unknown[];
  const first = source[0] as unknown;
  const nested = Array.isArray(first);
  return (nested ? points as LatLngLike[][] : [points as LatLngLike[]])
    .map((ring) => ring.map((value) => latLng(value)));
}

export class Polygon extends Polyline {
  rings: LatLng[][];

  constructor(points: LatLngLike[] | LatLngLike[][], options: PathOptions = {}) {
    const rings = normalizeRings(points);
    super(rings[0] ?? [], { fill: options.fill ?? "#2563eb", ...options });
    this.rings = rings;
    this.supportsArrows = false;
  }

  protected override interactionPointerEvents(): "all" {
    return "all";
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
      const source = this.options.geodesic && this.map?.crs.code !== "Simple" ? densifyLatLngs(ring, true) : ring;
      for (const value of source) result.extend(value);
    }
    return result;
  }

  override queryHit(target: PointLikeXY, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const rings = this.rings.map((ring) => ring.map((value) => this.map!.latLngToContainerPoint(value)));
    let inside = false;
    for (const ring of rings) if (ringContainsPoint(target, ring)) inside = !inside;
    const tolerance = options.tolerance + this.options.strokeWidth / 2;
    const onStroke = rings.some((ring) => ring.some((point, index) =>
      segmentDistance(target, point, ring[(index + 1) % ring.length]) <= tolerance
    ));
    if (!inside && !onStroke) return null;
    return { layer: this, latlng: this.map.containerPointToLatLng(target), source: "svg" };
  }

  override render(): void {
    PathLayer.prototype.render.call(this);
    if (!this.map || !this.path) return;
    const projectedRings = this.rings.map((ring) => {
      let source = ring;
      if (this.options.geodesic && this.map!.crs.code === "EPSG:3857" && ring.length > 1) {
        source = densifyLatLngs(ring, true);
      }
      return source.map((value) => this.map!.latLngToLayerPoint(value));
    });
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
    const target = bounds(value);
    super([
      target.getNorthWest(),
      target.getNorthEast(),
      target.getSouthEast(),
      target.getSouthWest()
    ], options);
    this.rectangleBounds = new LatLngBounds(target);
  }

  setBounds(value: LatLngBoundsLike): this {
    const target = bounds(value);
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
    return this.options.geodesic ? super.getBounds() : new LatLngBounds(this.rectangleBounds);
  }
}

/** Exactly one explicit radius unit; map units are supported only by CRS.Simple. */
export type CircleRadius =
  | { readonly radiusMeters: number; readonly radiusMapUnits?: never }
  | { readonly radiusMapUnits: number; readonly radiusMeters?: never };

function normalizeCircleRadius(radius: CircleRadius): CircleRadius {
  // Discriminate on the value, not on key presence: `{ radiusMeters: undefined }`
  // must read as "not supplied" rather than silently selecting the other unit.
  const meters = radius && typeof radius === "object" ? radius.radiusMeters : undefined;
  const mapUnits = radius && typeof radius === "object" ? radius.radiusMapUnits : undefined;
  if ((meters === undefined) === (mapUnits === undefined)) {
    throw new TypeError("Circle requires exactly one of { radiusMeters } or { radiusMapUnits }.");
  }
  return meters !== undefined
    ? { radiusMeters: nonNegativeFinite(meters, "radiusMeters") }
    : { radiusMapUnits: nonNegativeFinite(mapUnits!, "radiusMapUnits") };
}

export class Circle extends PathLayer {
  center: LatLng;
  #radius: CircleRadius;

  constructor(center: LatLngLike, radius: CircleRadius, options?: PathOptions) {
    super(options);
    this.center = latLng(center);
    this.#radius = normalizeCircleRadius(radius);
  }

  get #radiusValue(): number { return this.#radius.radiusMeters ?? this.#radius.radiusMapUnits!; }

  #assertCRS(map: Orihon, radius = this.#radius): void {
    const mapUnits = radius.radiusMapUnits !== undefined;
    if (mapUnits !== (map.crs.code === "Simple")) {
      throw new CRSCompatibilityError(mapUnits
        ? "radiusMapUnits requires CRS.Simple. Use radiusMeters on geographic maps."
        : "radiusMeters requires EPSG:3857. Use radiusMapUnits on CRS.Simple.");
    }
  }

  override onAdd(map: Orihon): void {
    this.#assertCRS(map);
    super.onAdd(map);
  }

  protected override interactionPointerEvents(): "all" {
    return "all";
  }

  getLatLng(): LatLng { return this.center.clone(); }
  getRadius(): CircleRadius { return { ...this.#radius }; }

  getRadiusMeters(): number {
    if (this.#radius.radiusMeters === undefined) {
      throw new TypeError("Circle is using radiusMapUnits. Call getRadiusMapUnits() or setRadiusMeters().");
    }
    return this.#radius.radiusMeters;
  }

  getRadiusMapUnits(): number {
    if (this.#radius.radiusMapUnits === undefined) {
      throw new TypeError("Circle is using radiusMeters. Call getRadiusMeters() or setRadiusMapUnits().");
    }
    return this.#radius.radiusMapUnits;
  }

  getBounds(): LatLngBounds {
    if (this.#radius.radiusMapUnits !== undefined) {
      return new LatLngBounds(
        { lat: this.center.lat - this.#radiusValue, lng: this.center.lng - this.#radiusValue },
        { lat: this.center.lat + this.#radiusValue, lng: this.center.lng + this.#radiusValue }
      );
    }
    if (this.options.geodesic) {
      const result = new LatLngBounds();
      for (const value of this.#geodesicRing(64)) result.extend(value);
      return result;
    }
    const latDelta = (this.#radiusValue / EARTH_RADIUS) * (180 / Math.PI);
    const lngScale = Math.max(1e-6, Math.cos((this.center.lat * Math.PI) / 180));
    const lngDelta = latDelta / lngScale;
    return new LatLngBounds(
      { lat: this.center.lat - latDelta, lng: this.center.lng - lngDelta },
      { lat: this.center.lat + latDelta, lng: this.center.lng + lngDelta }
    );
  }

  queryHit(target: PointLikeXY, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const center = this.map.latLngToContainerPoint(this.center);
    if (this.options.geodesic && this.map.crs.code === "EPSG:3857") {
      const ring = this.#geodesicRing(this.#geodesicVertexCount())
        .map((value) => this.map!.latLngToContainerPoint(value));
      const inside = ringContainsPoint(target, ring);
      const tolerance = options.tolerance + this.options.strokeWidth / 2;
      const onStroke = ring.some((point, index) =>
        segmentDistance(target, point, ring[(index + 1) % ring.length]) <= tolerance
      );
      if (!inside && !onStroke) return null;
    } else {
      const radius = Math.max(0, this.map.crs.code === "Simple"
        ? Math.abs(this.#radiusValue) * this.map.crs.scale(this.map.zoom)
        : metersToPixels(this.#radiusValue, this.center.lat, this.map.zoom));
      const distance = Math.hypot(target.x - center.x, target.y - center.y);
      if (distance > radius + options.tolerance) return null;
    }
    return { layer: this, latlng: this.map.containerPointToLatLng(target), source: "svg" };
  }

  setLatLng(value: LatLngLike): this {
    this.center = latLng(value);
    this.render();
    return this;
  }

  setRadius(radius: CircleRadius): this {
    const next = normalizeCircleRadius(radius);
    if (this.map) this.#assertCRS(this.map, next);
    this.#radius = next;
    this.render();
    return this;
  }

  setRadiusMeters(radiusMeters: number): this {
    return this.setRadius({ radiusMeters });
  }

  setRadiusMapUnits(radiusMapUnits: number): this {
    return this.setRadius({ radiusMapUnits });
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    if (this.options.geodesic && this.map.crs.code === "EPSG:3857") {
      const vertexCount = this.#geodesicVertexCount();
      const points = this.#geodesicRing(vertexCount).map((value) => this.map!.latLngToLayerPoint(value));
      if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, projectedBounds(points), this.options.clipPadding)) {
        this.path.setAttribute("d", "");
        return;
      }
      this.path.setAttribute("d", projectedPointsToPath(points, true));
      return;
    }
    const center = this.map.latLngToLayerPoint(this.center);
    const radius = Math.max(0, this.map.crs.code === "Simple"
      ? Math.abs(this.#radiusValue) * this.map.crs.scale(this.map.zoom)
      : metersToPixels(this.#radiusValue, this.center.lat, this.map.zoom));
    if (!this.options.noClip && !projectedBoundsIntersectsViewport(this.map, {
      minX: center.x - radius,
      minY: center.y - radius,
      maxX: center.x + radius,
      maxY: center.y + radius
    }, this.options.clipPadding)) {
      this.path.setAttribute("d", "");
      return;
    }
    this.path.setAttribute("d", projectedCirclePath(center, radius));
  }

  #geodesicRing(vertexCount: number): LatLng[] {
    return Array.from({ length: vertexCount }, (_, index) => destination(
      this.center,
      this.#radiusValue,
      index * 360 / vertexCount
    ));
  }

  #geodesicVertexCount(): number {
    return Math.max(32, Math.min(64, 32 + Math.ceil(Math.log2(Math.max(1, this.#radiusValue / 10_000))) * 4));
  }
}

export interface CircleMarkerOptions extends PathOptions {
  /** Radius in CSS pixels, independent of zoom. Default 10. */
  radiusPixels?: number;
}

export class CircleMarker extends PathLayer {
  center: LatLng;
  #radiusPixels: number;
  get radiusPixels(): number { return this.#radiusPixels; }

  constructor(center: LatLngLike, options: CircleMarkerOptions = {}) {
    super({ fill: options.fill ?? "#2563eb", ...options });
    this.center = latLng(center);
    rejectLegacyUnit(options, "radius", "radiusPixels");
    this.#radiusPixels = nonNegativeFinite(options.radiusPixels ?? 10, "radiusPixels");
  }

  protected override createPathElement(): SVGCircleElement {
    return createSvgEl("circle");
  }

  protected override interactionPointerEvents(): "all" {
    return "all";
  }

  getLatLng(): LatLng { return this.center.clone(); }
  getRadiusPixels(): number { return this.radiusPixels; }

  setLatLng(value: LatLngLike): this {
    this.center = latLng(value);
    this.render();
    return this;
  }

  setRadiusPixels(radiusPixels: number): this {
    this.#radiusPixels = nonNegativeFinite(radiusPixels, "radiusPixels");
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

  queryHit(target: PointLikeXY, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.options.interactive) return null;
    const center = this.map.latLngToContainerPoint(this.center);
    if (Math.hypot(target.x - center.x, target.y - center.y) > this.radiusPixels + options.tolerance) return null;
    return { layer: this, latlng: this.map.containerPointToLatLng(target), source: "svg" };
  }

  override render(): void {
    super.render();
    if (!this.map || !this.path) return;
    const center = this.map.latLngToLayerPoint(this.center);
    const radius = this.radiusPixels;
    const onScreen = Number.isFinite(center.x) && Number.isFinite(center.y) && (
      this.options.noClip
      || projectedBoundsIntersectsViewport(this.map, {
        minX: center.x - radius,
        minY: center.y - radius,
        maxX: center.x + radius,
        maxY: center.y + radius
      }, this.options.clipPadding)
    );
    if (!onScreen) {
      this.path.setAttribute("r", "0");
      return;
    }
    this.path.setAttribute("cx", String(center.x));
    this.path.setAttribute("cy", String(center.y));
    this.path.setAttribute("r", String(radius));
  }
}

export function polyline(points: LatLngLike[], options?: PathOptions): Polyline { return new Polyline(points, options); }
export function polygon(points: LatLngLike[] | LatLngLike[][], options?: PathOptions): Polygon { return new Polygon(points, options); }
export function rectangle(value: LatLngBoundsLike, options?: PathOptions): Rectangle { return new Rectangle(value, options); }
export function circle(center: LatLngLike, radius: CircleRadius, options?: PathOptions): Circle { return new Circle(center, radius, options); }
export function circleMarker(center: LatLngLike, options?: CircleMarkerOptions): CircleMarker { return new CircleMarker(center, options); }
