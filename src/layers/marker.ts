import { createEl, listen, listenTap, setTransform } from "../dom.js";
import { LatLng, latLng, type LatLngLike, type Point } from "../geo.js";
import { Layer, type LayerOptions, type QueryHit, type ResolvedQueryOptions } from "../layer.js";
import type { Orihon } from "../map.js";
import type { MarkerIcon } from "./icon.js";

export interface MarkerOptions extends LayerOptions {
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

export class Marker extends Layer<ResolvedMarkerOptions> {
  position: LatLng;
  el: HTMLButtonElement | null = null;
  iconElement: HTMLElement | null = null;
  shadowElement: HTMLElement | null = null;
  readonly _unsub: Array<() => void> = [];
  readonly _dragUnsub: Array<() => void> = [];

  constructor(position: LatLngLike, options: MarkerOptions = {}) {
    super({
      pane: "marker",
      title: "",
      className: "",
      draggable: false,
      anchor: [12, 36],
      content: null,
      html: "",
      ariaLabel: "",
      icon: null,
      opacity: 1,
      zIndexOffset: 0,
      keyboard: true,
      rotation: 0,
      rotationOrigin: "center bottom",
      ...options
    } as ResolvedMarkerOptions);
    this.position = latLng(position);
    this.options.opacity = Math.max(0, Math.min(1, Number(this.options.opacity)));
    this.options.zIndexOffset = Number.isFinite(Number(this.options.zIndexOffset)) ? Number(this.options.zIndexOffset) : 0;
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
    setTransform(this.el, projected.x - anchor.x, projected.y - anchor.y);
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
    this.el.style.width = "";
    this.el.style.height = "";
    this.el.classList.remove("oh-marker-custom");
    this.el.replaceChildren();
    const content = this.options.content ?? this.options.html;
    if (typeof Node !== "undefined" && content instanceof Node) {
      this.el.replaceChildren(content);
      return;
    }
    if (content !== null && content !== undefined && content !== "") {
      this.el.textContent = String(content);
      return;
    }
    createEl("span", "oh-marker-pin", this.el);
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
