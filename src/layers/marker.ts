import { createEl, listen, listenTap } from "../dom.js";
import { geoTransformCss } from "../camera.js";
import { LatLng, latLng, type LatLngLike, type Point } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { MarkerIcon } from "./icon.js";

/** Built-in marker glyph when no custom `icon` / `content` is set. */
export type MarkerShape = "pin" | "circle" | "square" | "dot" | "diamond" | "triangle";

export interface MarkerAppearance {
  shape?: MarkerShape;
  /** Fill color of the built-in glyph. */
  color?: string;
  /** Stroke / border color of the built-in glyph. */
  strokeColor?: string;
  /** Glyph size in CSS pixels (pin head / circle / square / dot). */
  size?: number;
  /** Border width in CSS pixels. */
  strokeWidth?: number;
}

export interface MarkerOptions extends LayerOptions, MarkerAppearance {
  title?: string;
  className?: string;
  draggable?: boolean;
  anchor?: [number, number];
  content?: Node | string | number | null;
  html?: string;
  ariaLabel?: string;
  icon?: MarkerIcon | null;
  opacity?: number;
  zIndexOffset?: number;
  keyboard?: boolean;
  rotation?: number;
  rotationOrigin?: string;
}

type ResolvedMarkerOptions = Required<Omit<MarkerOptions, "pane" | "attribution" | "content" | "icon">> &
  Pick<MarkerOptions, "pane" | "attribution"> & {
    content: Node | string | number | null;
    icon: MarkerIcon | null;
  };

const MARKER_SHAPES = new Set<MarkerShape>(["pin", "circle", "square", "dot", "diamond", "triangle"]);

function normalizeShape(value: unknown): MarkerShape {
  return MARKER_SHAPES.has(value as MarkerShape) ? (value as MarkerShape) : "pin";
}

function normalizeSize(value: unknown, fallback = 22): number {
  const size = Number(value);
  return Number.isFinite(size) ? Math.max(4, size) : fallback;
}

function normalizeStrokeWidth(value: unknown, fallback = 2): number {
  const width = Number(value);
  return Number.isFinite(width) ? Math.max(0, width) : fallback;
}

/** Layout box + tip/center anchor for a built-in glyph. */
export function markerShapeMetrics(appearance: MarkerAppearance = {}): {
  shape: MarkerShape;
  size: number;
  strokeWidth: number;
  width: number;
  height: number;
  anchor: [number, number];
  rotationOrigin: string;
} {
  const shape = normalizeShape(appearance.shape);
  const size = normalizeSize(appearance.size);
  const strokeWidth = normalizeStrokeWidth(appearance.strokeWidth);
  if (shape === "pin" || shape === "diamond" || shape === "triangle") {
    const width = Math.round(size + 2);
    const height = Math.round(size + 14);
    return {
      shape,
      size,
      strokeWidth,
      width,
      height,
      anchor: [width / 2, height],
      rotationOrigin: "center bottom"
    };
  }
  const box = Math.round(size + strokeWidth * 2);
  return {
    shape,
    size,
    strokeWidth,
    width: box,
    height: box,
    anchor: [box / 2, box / 2],
    rotationOrigin: "center center"
  };
}

export class Marker extends Layer<ResolvedMarkerOptions> {
  position: LatLng;
  el: HTMLButtonElement | null = null;
  iconElement: HTMLElement | null = null;
  shadowElement: HTMLElement | null = null;
  readonly _unsub: Array<() => void> = [];
  readonly _dragUnsub: Array<() => void> = [];

  constructor(position: LatLngLike, options: MarkerOptions = {}) {
    const shape = normalizeShape(options.shape);
    const size = normalizeSize(options.size);
    const strokeWidth = normalizeStrokeWidth(options.strokeWidth);
    const metrics = markerShapeMetrics({ shape, size, strokeWidth });
    const {
      shape: _shape,
      size: _size,
      strokeWidth: _strokeWidth,
      color: colorOpt,
      strokeColor: strokeColorOpt,
      anchor: anchorOpt,
      rotationOrigin: rotationOriginOpt,
      ...rest
    } = options;
    super({
      pane: "marker",
      title: "",
      className: "",
      draggable: false,
      content: null,
      html: "",
      ariaLabel: "",
      icon: null,
      opacity: 1,
      zIndexOffset: 0,
      keyboard: true,
      rotation: 0,
      ...rest,
      shape,
      size,
      strokeWidth,
      color: colorOpt ?? "#e11d48",
      strokeColor: strokeColorOpt ?? "#ffffff",
      anchor: anchorOpt ?? metrics.anchor,
      rotationOrigin: rotationOriginOpt ?? metrics.rotationOrigin
    } as ResolvedMarkerOptions);
    this.position = latLng(position);
    this.options.opacity = Math.max(0, Math.min(1, Number(this.options.opacity)));
    this.options.zIndexOffset = Number.isFinite(Number(this.options.zIndexOffset)) ? Number(this.options.zIndexOffset) : 0;
    this.options.shape = normalizeShape(this.options.shape);
    this.options.size = normalizeSize(this.options.size);
    this.options.strokeWidth = normalizeStrokeWidth(this.options.strokeWidth);
  }

  override onAdd(map: Orihon): void {
    super.onAdd(map);
    const pane = this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.el = createEl("button", `oh-marker ${this.options.className}`, pane);
    this.el.type = "button";
    this.el.title = this.options.title;
    this.el.setAttribute("aria-label", this.options.ariaLabel || this.options.title || "Map marker");
    this.el.tabIndex = this.options.keyboard ? 0 : -1;
    this.el.style.opacity = String(this.options.opacity);
    this.#setContent();
    this._unsub.push(listenTap(this.el, (event) => {
      event.stopPropagation();
      this.emit("click", { originalEvent: event, latlng: this.getLatLng() });
    }));
    this._unsub.push(listen(this.el, "pointerenter", (event) => {
      this.emit("mouseover", { originalEvent: event, latlng: this.getLatLng() });
    }));
    this._unsub.push(listen(this.el, "pointerleave", (event) => {
      this.emit("mouseout", { originalEvent: event, latlng: this.getLatLng() });
    }));
    if (this.options.draggable) this.#enableDrag();
    this.render();
  }

  override onRemove(): void {
    this.#disableDrag();
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    this.el?.remove();
    this.el = null;
    super.onRemove();
  }

  setLatLng(position: LatLngLike): this {
    this.position = latLng(position);
    this.render();
    return this;
  }

  getLatLng(): LatLng {
    return this.position.clone();
  }

  /** Enables or disables pointer dragging without recreating the marker. */
  setDraggable(draggable: boolean): this {
    this.options.draggable = Boolean(draggable);
    if (!this.el) return this;
    if (this.options.draggable) this.#enableDrag();
    else this.#disableDrag();
    return this;
  }

  isDraggable(): boolean {
    return this.options.draggable;
  }

  queryHit(target: Point, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.el) return null;
    const center = this.map.latLngToContainerPoint(this.position);
    const anchor = this.options.icon?.getAnchor() ?? { x: this.options.anchor[0], y: this.options.anchor[1] };
    const size = this.options.icon?.getSize() ?? {
      x: this.el.offsetWidth || Number.parseFloat(this.el.style.width) || 24,
      y: this.el.offsetHeight || Number.parseFloat(this.el.style.height) || 36
    };
    const left = center.x - anchor.x - options.tolerance;
    const top = center.y - anchor.y - options.tolerance;
    if (target.x < left || target.x > left + size.x + options.tolerance * 2
      || target.y < top || target.y > top + size.y + options.tolerance * 2) return null;
    return { layer: this, latlng: this.getLatLng(), source: "dom" };
  }

  setIcon(value: MarkerIcon | null): this {
    this.options.icon = value;
    this.#setContent();
    this.render();
    return this;
  }

  getIcon(): MarkerIcon | null {
    return this.options.icon;
  }

  /** Updates built-in glyph appearance (ignored while a custom `icon` is set). */
  setAppearance(appearance: MarkerAppearance): this {
    if (appearance.shape != null) this.options.shape = normalizeShape(appearance.shape);
    if (appearance.color != null) this.options.color = String(appearance.color);
    if (appearance.strokeColor != null) this.options.strokeColor = String(appearance.strokeColor);
    if (appearance.size != null) this.options.size = normalizeSize(appearance.size);
    if (appearance.strokeWidth != null) this.options.strokeWidth = normalizeStrokeWidth(appearance.strokeWidth);
    if (!this.options.icon) {
      const metrics = markerShapeMetrics(this.options);
      this.options.anchor = metrics.anchor;
      this.options.rotationOrigin = metrics.rotationOrigin;
    }
    this.#setContent();
    this.render();
    return this;
  }

  setOpacity(opacity: number): this {
    this.options.opacity = Math.max(0, Math.min(1, Number(opacity)));
    if (this.el) this.el.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndexOffset(offset: number): this {
    this.options.zIndexOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    this.render();
    return this;
  }

  override render(): void {
    if (!this.map || !this.el) return;
    const projected = this.map.latLngToLayerPoint(this.position);
    const anchor = this.options.icon?.getAnchor() ?? { x: this.options.anchor[0], y: this.options.anchor[1] };
    this.el.style.zIndex = String(Math.round(projected.y) + this.options.zIndexOffset);
    this.el.style.transform = geoTransformCss(projected.x - anchor.x, projected.y - anchor.y);
    if (this.options.rotation) {
      this.el.style.transform += ` rotate(${Number(this.options.rotation)}deg)`;
      this.el.style.transformOrigin = this.options.rotationOrigin;
    } else {
      this.el.style.transformOrigin = "";
    }
  }

  #setContent(): void {
    if (!this.el) return;
    if (this.options.icon) {
      this.iconElement = this.options.icon.createIcon(this.iconElement);
      this.shadowElement = this.options.icon.createShadow(this.shadowElement);
      const size = this.options.icon.getSize();
      this.el.style.width = `${size.x}px`;
      this.el.style.height = `${size.y}px`;
      this.el.classList.add("oh-marker-custom");
      this.el.replaceChildren(...[this.shadowElement, this.iconElement].filter((value): value is HTMLElement => Boolean(value)));
      return;
    }
    this.iconElement = null;
    this.shadowElement = null;
    this.el.classList.remove("oh-marker-custom");
    this.el.replaceChildren();
    const content = this.options.content ?? this.options.html;
    if (typeof Node !== "undefined" && content instanceof Node) {
      this.el.style.width = "";
      this.el.style.height = "";
      this.el.replaceChildren(content);
      return;
    }
    if (content !== null && content !== undefined && content !== "") {
      this.el.style.width = "";
      this.el.style.height = "";
      this.el.textContent = String(content);
      return;
    }
    const metrics = markerShapeMetrics(this.options);
    this.options.anchor = metrics.anchor;
    this.el.style.width = `${metrics.width}px`;
    this.el.style.height = `${metrics.height}px`;
    const pin = createEl("span", metrics.shape === "pin" ? "oh-marker-pin" : `oh-marker-pin is-${metrics.shape}`, this.el);
    pin.style.setProperty("--oh-marker-fill", this.options.color);
    pin.style.setProperty("--oh-marker-stroke", this.options.strokeColor);
    pin.style.setProperty("--oh-marker-size", `${metrics.size}px`);
    pin.style.setProperty("--oh-marker-stroke-width", `${metrics.strokeWidth}px`);
  }

  #enableDrag(): void {
    if (!this.el || this._dragUnsub.length) return;
    let active = false;
    const move = (event: PointerEvent): void => {
      if (!active || !this.map) return;
      const rect = this.map.container.getBoundingClientRect();
      this.position = this.map.containerPointToLatLng({ x: event.clientX - rect.left, y: event.clientY - rect.top });
      this.render();
      this.emit("drag", { latlng: this.getLatLng() });
    };
    const up = (): void => {
      if (!active) return;
      active = false;
      this.el?.classList.remove("oh-marker-dragging");
      this.emit("dragend", { latlng: this.getLatLng() });
    };
    this._dragUnsub.push(listen(this.el, "pointerdown", (event) => {
      event.stopPropagation();
      active = true;
      this.el?.setPointerCapture(event.pointerId);
      this.el?.classList.add("oh-marker-dragging");
      this.emit("dragstart", { latlng: this.getLatLng() });
    }));
    this._dragUnsub.push(listen(this.el, "pointermove", move));
    this._dragUnsub.push(listen(this.el, "pointerup", up));
    this._dragUnsub.push(listen(this.el, "pointercancel", up));
    this.el.classList.add("oh-marker-draggable");
  }

  #disableDrag(): void {
    for (const unsubscribe of this._dragUnsub.splice(0)) unsubscribe();
    this.el?.classList.remove("oh-marker-draggable", "oh-marker-dragging");
  }
}

export function marker(position: LatLngLike, options?: MarkerOptions): Marker {
  return new Marker(position, options);
}
