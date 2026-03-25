import { createEl, listen, listenTap } from "../dom.js";
import { geoTransformCss } from "../camera.js";
import { LatLng, latLng, type LatLngLike, type Point } from "../geo.js";
import { InteractiveLayer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { OverlayContent, PopupOptions, TooltipOptions } from "../overlays/div-overlay.js";
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

interface MarkerBaseOptions extends LayerOptions {
  html?: never;
  title?: string;
  className?: string;
  draggable?: boolean;
  ariaLabel?: string;
  opacity?: number;
  zIndexOffset?: number;
  keyboard?: boolean;
  /** Attach pointer/keyboard interaction listeners. Default true. */
  interactive?: boolean;
  rotation?: number;
  rotationOrigin?: string;
}

type NoMarkerAppearance = { [K in keyof MarkerAppearance]?: never };

/** Choose a built-in glyph, safe content, or an icon; these modes cannot be mixed. */
export type MarkerOptions = MarkerBaseOptions & (
  | (MarkerAppearance & { anchor?: [number, number]; content?: never; icon?: never })
  | (NoMarkerAppearance & { anchor?: [number, number]; content: Node | string | number; icon?: never })
  | (NoMarkerAppearance & { anchor?: never; icon: MarkerIcon; content?: never })
);

type ResolvedMarkerOptions = Required<Omit<MarkerBaseOptions, "pane" | "attribution" | "html">> &
  Pick<MarkerBaseOptions, "pane" | "attribution"> & Required<MarkerAppearance> & {
    anchor: [number, number];
    content: Node | string | number | null;
    icon: MarkerIcon | null;
  };

function validateContent(content: unknown): void {
  if (typeof content !== "string" && typeof content !== "number" && !(typeof Node !== "undefined" && content instanceof Node)) {
    throw new TypeError("Marker content must be a string, number or Node");
  }
}

function validateIcon(value: unknown): void {
  if (!value || typeof value !== "object" || ["createIcon", "createShadow", "getSize", "getAnchor"].some(
    (key) => typeof (value as Record<string, unknown>)[key] !== "function"
  )) throw new TypeError("Marker icon must implement createIcon(), createShadow(), getSize() and getAnchor()");
}

/** @internal Validate before collections or wrappers allocate resources. */
export function validateMarkerOptions(options: MarkerOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Marker options must be an object");
  if ("html" in options) throw new TypeError("Marker html was removed. Use content for plain text or a Node for markup.");
  const content = options.content !== undefined;
  const icon = options.icon !== undefined;
  const appearance = ["shape", "color", "strokeColor", "size", "strokeWidth"].some(
    (key) => (options as Record<string, unknown>)[key] !== undefined
  );
  if (Number(content) + Number(icon) + Number(appearance) > 1) {
    throw new TypeError("Marker accepts exactly one visual mode: appearance, content or icon");
  }
  if (content) validateContent(options.content);
  if (icon) {
    validateIcon(options.icon);
    if (options.anchor !== undefined) throw new TypeError("Set iconAnchor on the icon instead of Marker anchor");
  }
}

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

export interface MarkerEventMap {
  click: { originalEvent: MouseEvent | PointerEvent; latlng: LatLng };
  mouseover: { originalEvent: PointerEvent; latlng: LatLng };
  mouseout: { originalEvent: PointerEvent; latlng: LatLng };
  dragstart: { latlng: LatLng };
  drag: { latlng: LatLng };
  dragend: { latlng: LatLng };
}

export class Marker extends InteractiveLayer<ResolvedMarkerOptions, MarkerEventMap> {
  #customAnchor: boolean;
  #customRotationOrigin: boolean;
  position: LatLng;
  el: HTMLButtonElement | null = null;
  iconElement: HTMLElement | null = null;
  shadowElement: HTMLElement | null = null;
  readonly _unsub: Array<() => void> = [];
  readonly _dragUnsub: Array<() => void> = [];

  constructor(position: LatLngLike, options: MarkerOptions = {}) {
    validateMarkerOptions(options);
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
      ariaLabel: "",
      opacity: 1,
      zIndexOffset: 0,
      keyboard: true,
      interactive: true,
      rotation: 0,
      ...rest,
      content: options.content ?? null,
      icon: options.icon ?? null,
      shape,
      size,
      strokeWidth,
      color: colorOpt ?? "#e11d48",
      strokeColor: strokeColorOpt ?? "#ffffff",
      anchor: anchorOpt ?? metrics.anchor,
      rotationOrigin: rotationOriginOpt ?? metrics.rotationOrigin
    } as ResolvedMarkerOptions);
    this.#customAnchor = options.anchor !== undefined;
    this.#customRotationOrigin = options.rotationOrigin !== undefined;
    this.position = latLng(position);
    this.writableOptions.opacity = Math.max(0, Math.min(1, Number(this.options.opacity)));
    this.writableOptions.zIndexOffset = Number.isFinite(Number(this.options.zIndexOffset)) ? Number(this.options.zIndexOffset) : 0;
    this.writableOptions.shape = normalizeShape(this.options.shape);
    this.writableOptions.size = normalizeSize(this.options.size);
    this.writableOptions.strokeWidth = normalizeStrokeWidth(this.options.strokeWidth);
  }

  override onAdd(map: Orihon, parent?: HTMLElement | DocumentFragment): void {
    super.onAdd(map);
    const pane = parent ?? this.getPane();
    if (!pane) throw new Error(`Orihon pane not found: ${this.options.pane}`);
    this.el = createEl("button", `oh-marker ${this.options.className}`, pane);
    this.el.type = "button";
    this.el.title = this.options.title;
    this.el.tabIndex = this.options.keyboard ? 0 : -1;
    this.el.style.opacity = String(this.options.opacity);
    this.#setContent();
    this.#syncInteraction();
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
    this.writableOptions.draggable = Boolean(draggable);
    if (!this.el) return this;
    this.#syncInteraction();
    if (this.options.draggable) this.#enableDrag();
    else this.#disableDrag();
    return this;
  }

  isDraggable(): boolean {
    return this.options.draggable;
  }

  setInteractive(interactive: boolean): this {
    this.writableOptions.interactive = Boolean(interactive);
    this.#syncInteraction();
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

  queryHit(target: Point, options: ResolvedQueryOptions): QueryHit | null {
    if (!this.map || !this.el || (!this.options.interactive && !this.options.draggable)) return null;
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
    if (value !== null) validateIcon(value);
    this.writableOptions.icon = value;
    this.writableOptions.content = null;
    this.#resetVisualGeometry();
    this.#setContent();
    this.render();
    return this;
  }

  getIcon(): MarkerIcon | null {
    return this.options.icon;
  }

  /** Switches to safe text/Node content. Empty string is intentionally empty. */
  setContent(content: Node | string | number): this {
    validateContent(content);
    if (this.options.content === null) this.#resetVisualGeometry();
    this.writableOptions.icon = null;
    this.writableOptions.content = content;
    this.#setContent();
    this.render();
    return this;
  }

  getContent(): Node | string | number | null { return this.options.content; }

  /** Selects the built-in glyph and updates its appearance. */
  setAppearance(appearance: MarkerAppearance & { icon?: never; content?: never; html?: never }): this {
    validateMarkerOptions(appearance);
    if ("icon" in appearance || "content" in appearance) throw new TypeError("setAppearance accepts only built-in glyph properties");
    const switched = this.options.icon !== null || this.options.content !== null;
    this.writableOptions.icon = null;
    this.writableOptions.content = null;
    if (appearance.shape != null) this.writableOptions.shape = normalizeShape(appearance.shape);
    if (appearance.color != null) this.writableOptions.color = String(appearance.color);
    if (appearance.strokeColor != null) this.writableOptions.strokeColor = String(appearance.strokeColor);
    if (appearance.size != null) this.writableOptions.size = normalizeSize(appearance.size);
    if (appearance.strokeWidth != null) this.writableOptions.strokeWidth = normalizeStrokeWidth(appearance.strokeWidth);
    if (switched) this.#resetVisualGeometry();
    const metrics = markerShapeMetrics(this.options);
    if (!this.#customAnchor) this.writableOptions.anchor = metrics.anchor;
    if (!this.#customRotationOrigin) this.writableOptions.rotationOrigin = metrics.rotationOrigin;
    this.#setContent();
    this.render();
    return this;
  }

  setOpacity(opacity: number): this {
    this.writableOptions.opacity = Math.max(0, Math.min(1, Number(opacity)));
    if (this.el) this.el.style.opacity = String(this.options.opacity);
    return this;
  }

  setZIndexOffset(offset: number): this {
    this.writableOptions.zIndexOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
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

  #resetVisualGeometry(): void {
    this.#customAnchor = false;
    const metrics = markerShapeMetrics(this.options);
    this.writableOptions.anchor = metrics.anchor;
    if (!this.#customRotationOrigin) this.writableOptions.rotationOrigin = metrics.rotationOrigin;
  }

  #setContent(): void {
    if (!this.el) return;
    this.el.style.backgroundColor = "";
    this.el.style.borderRadius = "";
    this.el.style.boxShadow = "";
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
    const content = this.options.content;
    if (typeof Node !== "undefined" && content instanceof Node) {
      this.el.style.width = "";
      this.el.style.height = "";
      this.el.replaceChildren(content);
      return;
    }
    if (content !== null && content !== undefined) {
      this.el.style.width = "";
      this.el.style.height = "";
      this.el.textContent = String(content);
      return;
    }
    const metrics = markerShapeMetrics(this.options);
    if (!this.#customAnchor) this.writableOptions.anchor = metrics.anchor;
    this.el.style.width = `${metrics.width}px`;
    this.el.style.height = `${metrics.height}px`;
    if (!this.options.interactive && !this.options.draggable && metrics.shape === "dot") {
      // One-node fast path for dense, non-interactive DOM collections.
      this.el.style.backgroundColor = this.options.color;
      this.el.style.borderRadius = "999px";
      return;
    }
    const pin = createEl("span", metrics.shape === "pin" ? "oh-marker-pin" : `oh-marker-pin is-${metrics.shape}`, this.el);
    pin.style.setProperty("--oh-marker-fill", this.options.color);
    pin.style.setProperty("--oh-marker-stroke", this.options.strokeColor);
    pin.style.setProperty("--oh-marker-size", `${metrics.size}px`);
    pin.style.setProperty("--oh-marker-stroke-width", `${metrics.strokeWidth}px`);
  }

  #syncInteraction(): void {
    for (const unsubscribe of this._unsub.splice(0)) unsubscribe();
    if (!this.el) return;
    const enabled = this.options.interactive || this.options.draggable;
    this.el.style.pointerEvents = enabled ? "auto" : "none";
    if (enabled) {
      this.el.removeAttribute("aria-hidden");
      this.el.setAttribute("aria-label", this.options.ariaLabel || this.options.title || "Map marker");
    } else {
      this.el.removeAttribute("aria-label");
      this.el.setAttribute("aria-hidden", "true");
    }
    if (!this.options.interactive) return;
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
